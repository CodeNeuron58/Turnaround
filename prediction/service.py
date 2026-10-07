"""Turnaround prediction service — TabPFN hike-time quantiles + trip storage.

Endpoints:
    GET  /health                    -> model/db status, your current pace factor
    POST /predict                   -> duration quantiles for one hike, tuned to you
    POST /route/analyze             -> GPX in; model features + trailhead/centre coords out
    POST /trips                     -> plan a trip (predicts, stores, returns its timeline)
    GET  /trips                     -> trip history
    GET  /trips/{id}                -> one trip with its timeline (the app resumes from this)
    POST /trips/{id}/start          -> hiker set off: arms the Temporal safety timer
    POST /trips/{id}/arm            -> retry a safety timer that failed to arm at start
    POST /trips/{id}/checkout       -> "I'm out": records the time, stops the timer (idempotent)
    POST /trips/{id}/briefing       -> Gemma writes the spoken briefing (once; stored)
    POST /trips/{id}/briefing/audio -> Piper renders it to a wav

Two layers of prediction:
  1. TabPFN models the crowd: a fixed, seeded sample of the 7,186 hikr.org
     hikes, in context, fitted once at boot (TABPFN_MODEL_PATH; default the fast
     v2 checkpoint in data/models/).
  2. A personal pace factor tunes it to you: each finished hike's moving time
     over the crowd's median for that same route, averaged in log space and
     shrunk toward 1.0 while your history is thin. Personal hikes used to ride
     along in TabPFN's context instead — measured, three of them moved the
     median by under 1% against 2,000 strangers, so the factor is explicit now.

Every moment of a trip comes from timeline(), so the app, the briefing and the
alert email can never disagree about when to turn around.
"""

from __future__ import annotations

import asyncio
import math
import os
import pathlib
import re
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager, closing, suppress
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

ROOT = pathlib.Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")  # optional; real environment variables still win
os.environ.setdefault("TABPFN_ALLOW_CPU_LARGE_DATASET", "1")

import numpy as np
import pandas as pd
import gpxpy
import requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from tabpfn import TabPFNRegressor
from temporalio.exceptions import WorkflowAlreadyStartedError

DATA = ROOT / "data" / "processed" / "hikes.csv"
DEFAULT_CKPT = ROOT / "data" / "models" / "tabpfn-v2-regressor.ckpt"
DB_PATH = pathlib.Path(os.environ.get("TURNAROUND_DB", str(ROOT / "data" / "trips.db")))
FEATURES = ["distance_km", "climb_m", "descent_m", "highest_m", "t_grade"]
TARGET = "duration_min"
QUANTILES = [0.05, 0.5, 0.9, 0.95]
SEED = 42
# Serving config: a full 7k-hike context costs minutes per prediction on CPU.
# A subsampled context + small ensemble keeps responses in the ~10s range;
# the offline evaluation (results/) uses the full dataset.
CONTEXT_ROWS = int(os.environ.get("TABPFN_CONTEXT_ROWS", "2000"))
N_ESTIMATORS = int(os.environ.get("TABPFN_N_ESTIMATORS", "6"))

# A personal hike only teaches the pace factor if it looks like a real hike —
# the same bounds build_dataset.py applies to the crowd. A three-minute test
# check-in must never tell the model you're fast.
MIN_TRAIN_MIN = 15.0
MAX_TRAIN_MIN = 20 * 60.0
# pseudo-hikes at factor 1.0: your first hike moves you a third of the way
PACE_SHRINK = 2.0
PACE_BOUNDS = (0.6, 1.8)
RATIO_BOUNDS = (0.4, 2.5)
# slack after the slow (P95) estimate, breaks included, before the contact is emailed
ALERT_GRACE_MIN = float(os.environ.get("ALERT_GRACE_MIN", "30"))

_predict_lock = threading.Lock()
_briefing_lock = threading.Lock()
_state: dict = {"reg": None, "model": "", "training_rows": 0, "temporal": None}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CONTROL_CHARS = re.compile(r"[\r\n\x00-\x1f]")

# --- the rest of the stack (all local, all optional at boot) ---
TEMPORAL_ADDRESS = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
TEMPORAL_TASK_QUEUE = os.environ.get("TEMPORAL_TASK_QUEUE", "turnaround-trips")
LATE_WINDOW_HOURS = float(os.environ.get("LATE_WINDOW_HOURS", "6"))
GEMMA_BASE_URL = os.environ.get("GEMMA_BASE_URL", "http://127.0.0.1:11434/v1")
GEMMA_MODEL = os.environ.get("GEMMA_MODEL", "gemma4:e4b")
PIPER_BIN = os.environ.get("PIPER_BIN", str(ROOT / "tools" / "piper-bin" / "piper" / "piper.exe"))
PIPER_VOICE = os.environ.get("PIPER_VOICE", str(ROOT / "tools" / "piper" / "voice" / "en_US-amy-medium.onnx"))
BRIEFINGS_DIR = ROOT / "data" / "briefings"

SCHEMA = """
CREATE TABLE IF NOT EXISTS trips(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  distance_km REAL NOT NULL, climb_m REAL NOT NULL, descent_m REAL NOT NULL,
  highest_m REAL NOT NULL, t_grade INTEGER NOT NULL,
  p5_min REAL, expected_min REAL, p90_min REAL, p95_min REAL,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, actual_min REAL
);
CREATE TABLE IF NOT EXISTS personal_hikes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  distance_km REAL NOT NULL, climb_m REAL NOT NULL, descent_m REAL NOT NULL,
  highest_m REAL NOT NULL, t_grade INTEGER NOT NULL,
  duration_min REAL NOT NULL, created_at TEXT NOT NULL
);
"""
# Columns added since the first schema; init_schema() adds whichever are missing,
# so an existing trips.db upgrades in place.
ADDED_COLUMNS = {
    "trips": {
        "hiker_name": "TEXT",
        "breaks_min": "REAL NOT NULL DEFAULT 0",
        "pace_factor": "REAL NOT NULL DEFAULT 1",
        "crowd_min": "REAL",  # the crowd model's median, before your pace factor
        "lat": "REAL",  # track midpoint
        "lon": "REAL",
        "start_lat": "REAL",  # first trackpoint: the trailhead
        "start_lon": "REAL",
        "sunset_at": "TEXT",
        "rain_pct": "REAL",
        "planned_start": "TEXT",
        "drill_alert_sec": "INTEGER",
        "timer_status": "TEXT NOT NULL DEFAULT 'not_started'",
        "moving_min": "REAL",
        "briefing": "TEXT",
    },
    "personal_hikes": {
        "crowd_min": "REAL",
        "source": "TEXT",  # trip:<id> or gpx:<file name>
    },
}


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_schema() -> None:
    with closing(db()) as conn:
        conn.executescript(SCHEMA)
        for table, cols in ADDED_COLUMNS.items():
            have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for col, decl in cols.items():
                if col not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        conn.commit()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fit_model() -> None:
    """Fit the crowd model, once, at boot. The context is a fixed, seeded sample
    of hikr.org hikes, so the crowd's median for a route never drifts — which is
    what lets a stored crowd median stand in for it when the pace factor is
    computed later."""
    t0 = time.time()
    model_path = os.environ.get("TABPFN_MODEL_PATH")
    if not model_path:
        if not DEFAULT_CKPT.exists():
            raise RuntimeError(
                f"No TabPFN checkpoint at {DEFAULT_CKPT} and TABPFN_MODEL_PATH is unset"
            )
        model_path = str(DEFAULT_CKPT)
    df = pd.read_csv(DATA)
    if CONTEXT_ROWS < len(df):
        df = df.sample(n=CONTEXT_ROWS, random_state=SEED)
    reg = TabPFNRegressor(model_path=model_path, random_state=SEED, n_estimators=N_ESTIMATORS)
    reg.fit(df[FEATURES], df[TARGET])
    _state.update(reg=reg, model=pathlib.Path(model_path).name, training_rows=len(df))
    print(f"[turnaround] fitted on {len(df)} hikes in {time.time() - t0:.0f}s", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_schema()
    try:
        fit_model()
    except Exception as e:  # serve 503s rather than refusing to boot
        print(f"[turnaround] startup fit failed: {e}", flush=True)
    try:
        # first real predict pays torch's lazy init (~90s cold); pay it here so
        # the first request is fast
        t0 = time.time()
        predict_quantiles({
            "distance_km": 12.6, "climb_m": 1005.0, "descent_m": 950.0,
            "highest_m": 1999.0, "t_grade": 3,
        })
        print(f"[turnaround] warm-up predict done in {time.time() - t0:.0f}s", flush=True)
    except Exception as e:
        print(f"[turnaround] warm-up skipped: {e}", flush=True)
    try:
        await _temporal()
        print(f"[turnaround] Temporal connected at {TEMPORAL_ADDRESS}", flush=True)
    except Exception as e:
        print(f"[turnaround] Temporal unavailable ({e}) — will retry when a trip starts", flush=True)
    yield
    client = _state.get("temporal")
    if client is not None:
        with suppress(Exception):
            await client.close()


app = FastAPI(title="Turnaround prediction service", lifespan=lifespan)
# the app normally reaches the service through vite's /api proxy (same origin);
# CORS covers direct calls from the dev server's own origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Features(BaseModel):
    # plausibility bounds mirror build_dataset.py — the model never saw anything
    # outside this range, and out-of-range garbage degrades predictions for everyone
    distance_km: float = Field(gt=0, le=50, description="route length in km")
    climb_m: float = Field(ge=0, le=4500)
    descent_m: float = Field(ge=0, le=8000)
    highest_m: float = Field(ge=0, le=5500)
    t_grade: int = Field(ge=1, le=6, description="SAC scale T1-T6")


def predict_quantiles(features: dict) -> dict:
    """The crowd's moving-time quantiles for one route (TabPFN, no personal layer)."""
    reg = _state["reg"]
    if reg is None:
        raise HTTPException(503, "model is still fitting, try again shortly")
    X = pd.DataFrame([features])[FEATURES]
    with _predict_lock:
        q = np.asarray(reg.predict(X, output_type="quantiles", quantiles=QUANTILES))
    if q.shape == (len(QUANTILES),):
        q = q.reshape(1, -1)
    if q.shape != (1, len(QUANTILES)):
        if q.shape == (len(QUANTILES), 1):
            q = q.T
        else:
            raise HTTPException(502, f"model returned unexpected quantile shape {q.shape}")
    q = np.clip(q, 1.0, None)
    if not np.isfinite(q).all():
        # TabPFN can emit NaN for far-out features; a bare NaN serializes as
        # invalid JSON and would poison the client
        raise HTTPException(502, "model returned non-finite estimates — features likely outside the training range")
    p05, p50, p90, p95 = (float(v) for v in q[0])
    return {"p5_min": p05, "expected_min": p50, "p90_min": p90, "p95_min": p95}


def pace_factor(ratios: list[float]) -> float:
    """Your pace relative to the crowd: the geometric mean of actual/crowd-median
    ratios, shrunk toward 1.0 by PACE_SHRINK pseudo-hikes and clamped, so one odd
    day can't swing the safety timer far in either direction."""
    if not ratios:
        return 1.0
    logs = [math.log(min(RATIO_BOUNDS[1], max(RATIO_BOUNDS[0], r))) for r in ratios]
    f = math.exp(sum(logs) / (len(logs) + PACE_SHRINK))
    return min(PACE_BOUNDS[1], max(PACE_BOUNDS[0], f))


def your_pace() -> tuple[float, int]:
    """(pace factor, number of personal hikes behind it)."""
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT duration_min, crowd_min FROM personal_hikes"
            " WHERE crowd_min > 0 AND duration_min BETWEEN ? AND ?",
            (MIN_TRAIN_MIN, MAX_TRAIN_MIN),
        ).fetchall()
    return pace_factor([r["duration_min"] / r["crowd_min"] for r in rows]), len(rows)


def predict_for_you(features: dict) -> dict:
    """The crowd's quantiles scaled by your pace factor."""
    crowd = predict_quantiles(features)
    factor, n = your_pace()
    return {
        **{k: v * factor for k, v in crowd.items()},
        "crowd_expected_min": crowd["expected_min"],
        "pace_factor": round(factor, 3),
        "pace_hikes": n,
    }


def turnaround_share(distance_km: float, climb_m: float) -> float:
    """Share of the cautious trip time to spend heading out before turning
    around, assuming you retrace your steps from the far point. Naismith's
    split: 12 min per km each way, plus 1 min per 10 m of ascent, all of it on
    the way out. Clamped to 0.5-0.7 — flat routes split evenly, steep ones
    front-load the effort."""
    out = 6.0 * distance_km + 0.1 * climb_m
    back = 6.0 * distance_km
    return min(0.7, max(0.5, out / (out + back)))


def timeline(row) -> dict:
    """Minutes after the start for every moment a trip cares about, plus clock
    times once it has started. The model predicts time in motion; the clock
    doesn't stop for lunch, so planned breaks are added to every moment.

    turn_around  — not at the top / far end by now? head back
    back_by      — P90 + breaks: 9 in 10 similar hikes are done by now
    alert        — P95 + breaks + grace: the contact is emailed if no check-in
    """
    breaks = row["breaks_min"] or 0.0
    back_by = row["p90_min"] + breaks
    if row["drill_alert_sec"]:
        alert = row["drill_alert_sec"] / 60
    else:
        alert = row["p95_min"] + breaks + ALERT_GRACE_MIN
    t = {
        "turn_around_after_min": round(turnaround_share(row["distance_km"], row["climb_m"]) * back_by, 1),
        "expected_back_after_min": round(row["expected_min"] + breaks, 1),
        "back_by_after_min": round(back_by, 1),
        "alert_after_min": round(alert, 2),
    }
    if row["started_at"]:
        start = datetime.fromisoformat(row["started_at"])
        for k in list(t):
            at = start + timedelta(minutes=t[k])
            t[k.replace("_after_min", "_at")] = at.isoformat(timespec="seconds")
    return t


def trip_out(row) -> dict:
    return {**dict(row), **timeline(row), "drill": bool(row["drill_alert_sec"])}


def get_trip(trip_id: int):
    with closing(db()) as conn:
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "trip not found")
    return row


@app.get("/health")
def health() -> dict:
    factor, n = your_pace()
    return {
        "status": "ready" if _state["reg"] is not None else "fitting",
        "model": _state["model"],
        "training_rows": _state["training_rows"],
        "pace_factor": round(factor, 3),
        "pace_hikes": n,
        "db": str(DB_PATH),
    }


@app.post("/predict")
def predict(f: Features) -> dict:
    return predict_for_you(f.model_dump())


def route_features(gpx) -> dict:
    """Model features + coordinates from a parsed GPX. Shared by /route/analyze
    and the personal-hike importer, so both measure a route the same way."""
    length_m = gpx.length_2d() or 0
    up = down = 0.0
    with suppress(Exception):
        up, down = gpx.get_uphill_downhill()
    extremes = gpx.get_elevation_extremes()
    bounds = None
    with suppress(Exception):
        bounds = gpx.get_bounds()
    first = next(iter(gpx.walk(only_points=True)), None)
    if length_m <= 0 or bounds is None or first is None:
        raise ValueError("GPX contains no trackpoints")
    return {
        "distance_km": round(length_m / 1000, 3),
        "climb_m": round(up or 0.0, 1),
        "descent_m": round(down or 0.0, 1),
        "highest_m": round(extremes.maximum or 0.0, 1),
        "lat": round((bounds.min_latitude + bounds.max_latitude) / 2, 5),
        "lon": round((bounds.min_longitude + bounds.max_longitude) / 2, 5),
        "start_lat": round(first.latitude, 5),
        "start_lon": round(first.longitude, 5),
    }


@app.post("/route/analyze")
async def analyze_route(request: Request, t_grade: int | None = None) -> dict:
    """Analyze an uploaded GPX route (send the file as the raw request body).
    Returns the exact feature dict /predict and /trips expect. The SAC grade
    can't be derived from a track alone — the Plan screen asks the hiker for it."""
    if int(request.headers.get("content-length", "0") or 0) > 10_000_000:
        raise HTTPException(413, "GPX too large (10 MB cap)")
    if t_grade is not None and not 1 <= t_grade <= 6:
        raise HTTPException(422, "t_grade must be 1-6")
    raw = await request.body()
    try:
        gpx = gpxpy.parse(raw.decode("utf-8", errors="replace"))
    except Exception as e:
        raise HTTPException(400, f"could not parse GPX: {e}")
    try:
        feats = route_features(gpx)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {**feats, "t_grade": t_grade}


def _clean_text(v: str | None) -> str | None:
    # names flow into escalation emails; a newline would smuggle headers the
    # moment a real mail provider replaces the outbox
    if v is None:
        return None
    if CONTROL_CHARS.search(v):
        raise ValueError("contains control characters")
    return v.strip() or None


def _clean_iso(v: str | None) -> str | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("not an ISO-8601 time")
    if d.tzinfo is None:
        raise ValueError("time needs a UTC offset")
    return d.astimezone(timezone.utc).isoformat(timespec="seconds")


class TripCreate(Features):
    name: str = Field(min_length=1, max_length=120)
    contact_email: str | None = None
    hiker_name: str | None = Field(None, max_length=60)
    breaks_min: float = Field(30, ge=0, le=480, description="planned stops — the model predicts moving time only")
    lat: float | None = Field(None, ge=-90, le=90)
    lon: float | None = Field(None, ge=-180, le=180)
    start_lat: float | None = Field(None, ge=-90, le=90)
    start_lon: float | None = Field(None, ge=-180, le=180)
    sunset_at: str | None = None
    rain_pct: float | None = Field(None, ge=0, le=100)
    planned_start: str | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = _clean_text(v)
        if not v:
            raise ValueError("name is empty")
        return v

    @field_validator("hiker_name")
    @classmethod
    def _hiker(cls, v: str | None) -> str | None:
        return _clean_text(v)

    @field_validator("contact_email")
    @classmethod
    def _valid_email(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if CONTROL_CHARS.search(v) or not EMAIL_RE.match(v):
            raise ValueError("contact_email is not a valid address")
        return v

    @field_validator("sunset_at", "planned_start")
    @classmethod
    def _iso(cls, v: str | None) -> str | None:
        return _clean_iso(v)


@app.post("/trips", status_code=201)
def create_trip(t: TripCreate) -> dict:
    pred = predict_for_you({k: getattr(t, k) for k in FEATURES})
    cols = {
        "name": t.name,
        **{k: getattr(t, k) for k in FEATURES},
        "p5_min": pred["p5_min"], "expected_min": pred["expected_min"],
        "p90_min": pred["p90_min"], "p95_min": pred["p95_min"],
        "crowd_min": pred["crowd_expected_min"], "pace_factor": pred["pace_factor"],
        "contact_email": t.contact_email, "hiker_name": t.hiker_name,
        "breaks_min": t.breaks_min,
        "lat": t.lat, "lon": t.lon, "start_lat": t.start_lat, "start_lon": t.start_lon,
        "sunset_at": t.sunset_at, "rain_pct": t.rain_pct, "planned_start": t.planned_start,
        "created_at": now_iso(),
    }
    with closing(db()) as conn:
        cur = conn.execute(
            f"INSERT INTO trips({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})",
            list(cols.values()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id=?", (cur.lastrowid,)).fetchone()
    return {**trip_out(row), "pace_hikes": pred["pace_hikes"]}


@app.get("/trips")
def list_trips() -> list[dict]:
    with closing(db()) as conn:
        rows = conn.execute("SELECT * FROM trips ORDER BY id DESC").fetchall()
    return [trip_out(r) for r in rows]


@app.get("/trips/{trip_id}")
def read_trip(trip_id: int) -> dict:
    return trip_out(get_trip(trip_id))


# --- the safety timer -------------------------------------------------------

async def _temporal():
    """The Temporal client, connecting on first use — a service that booted
    before Temporal was up must not refuse timers for the rest of its life."""
    client = _state.get("temporal")
    if client is None:
        from temporalio.client import Client

        client = await Client.connect(TEMPORAL_ADDRESS)
        _state["temporal"] = client
    return client


def _point(lat, lon) -> dict | None:
    return {"lat": lat, "lon": lon} if lat is not None and lon is not None else None


def _trip_details(row) -> dict:
    """TripDetails for the TS tripWorkflow — key names must match exactly."""
    if not row["started_at"]:
        raise RuntimeError("trip has no start time")
    if not row["contact_email"]:
        raise RuntimeError("trip has no contact email — refusing to arm a timer that alerts nobody")
    t = timeline(row)
    alert_ms = datetime.fromisoformat(t["alert_at"]).timestamp() * 1000
    return {
        "tripId": row["id"],
        "hiker": row["hiker_name"] or "Your friend",
        "routeName": row["name"],
        "distanceKm": row["distance_km"],
        "climbM": row["climb_m"],
        "descentM": row["descent_m"],
        "highestM": row["highest_m"],
        "tGrade": row["t_grade"],
        "startedAtIso": row["started_at"],
        "expectedBackIso": t["expected_back_at"],
        "backByIso": t["back_by_at"],
        # measured from now, not from the start: a timer re-armed late still
        # fires at the original moment (1s floor — Temporal timers need > 0)
        "deadlineMs": max(1000, int(alert_ms - time.time() * 1000)),
        "lateCheckinWindowMs": int(LATE_WINDOW_HOURS * 3600 * 1000),
        "contactEmail": row["contact_email"],
        "breaksMin": row["breaks_min"] or 0,
        "trailhead": _point(row["start_lat"], row["start_lon"]),
        "routeCenter": _point(row["lat"], row["lon"]),
        "sunsetIso": row["sunset_at"],
        "rainChancePct": row["rain_pct"],
        "drill": bool(row["drill_alert_sec"]),
    }


async def _arm(row) -> str:
    """Start trip-<id>'s timer. Returns 'armed' or 'failed: <why>' — never raises,
    because the caller must tell the hiker either way."""
    try:
        client = await _temporal()
        await client.start_workflow(
            "tripWorkflow",
            _trip_details(row),
            id=f"trip-{row['id']}",  # deterministic: one timer per trip
            task_queue=TEMPORAL_TASK_QUEUE,
        )
        return "armed"
    except WorkflowAlreadyStartedError:
        # one hiker, one timer — but make sure the running one is THIS trip's,
        # not a leftover from an older trips.db that reused the id
        with suppress(Exception):
            desc = await (await _temporal()).get_workflow_handle(f"trip-{row['id']}").describe()
            started = datetime.fromisoformat(row["started_at"])
            if desc.start_time < started - timedelta(minutes=1):
                return (f"failed: a stale timer trip-{row['id']} from an earlier database is still running "
                        f"— terminate it in the Temporal UI, then try again")
        return "armed"
    except Exception as e:
        return f"failed: {e}"


async def _arm_and_record(trip_id: int) -> sqlite3.Row:
    status = await _arm(get_trip(trip_id))
    with closing(db()) as conn:
        conn.execute("UPDATE trips SET timer_status=? WHERE id=?", (status, trip_id))
        conn.commit()
    return get_trip(trip_id)


@app.post("/trips/{trip_id}/start")
async def start_trip(
    trip_id: int,
    alert_in_sec: int | None = Query(
        None, ge=30, le=86400,
        description="drills and tests only: email the contact this many seconds after the start",
    ),
) -> dict:
    with closing(db()) as conn:
        cur = conn.execute(
            "UPDATE trips SET status='active', started_at=?, drill_alert_sec=?"
            " WHERE id=? AND status='planned'",
            (now_iso(), alert_in_sec, trip_id),
        )
        if cur.rowcount == 0:
            row = conn.execute("SELECT status FROM trips WHERE id=?", (trip_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "trip not found")
            raise HTTPException(409, f"trip is {row['status']}, only planned trips can start")
        conn.commit()
    # the trip is real; the timer is the promise. if it didn't arm, the response
    # says so and the app shows it in red with a retry
    return trip_out(await _arm_and_record(trip_id))


@app.post("/trips/{trip_id}/arm")
async def arm_trip(trip_id: int) -> dict:
    row = get_trip(trip_id)
    if row["status"] != "active":
        raise HTTPException(409, f"trip is {row['status']} — only an active trip has a timer to arm")
    if row["timer_status"] == "armed":
        return trip_out(row)
    return trip_out(await _arm_and_record(trip_id))


class Checkout(BaseModel):
    actual_min: float = Field(gt=0, le=1500, description="minutes from the start to the \"I'm out\" tap, breaks included")


async def _signal_checkin(row) -> str:
    if row["timer_status"] != "armed":
        return "no_timer"
    try:
        handle = (await _temporal()).get_workflow_handle(f"trip-{row['id']}")
        await handle.signal("trip.checkedIn")
        return "delivered"
    except Exception as e:
        # a retried check-in (its first response lost on the way back) finds the
        # timer already closed — by that first signal, if the result says so
        with suppress(Exception):
            outcome = await asyncio.wait_for(handle.result(), 5)
            if "checked_in" in outcome or "late_checkin" in outcome:
                return "delivered"
        return f"failed: {e}"


def _alert_fired(row) -> bool:
    """The check-in reached the service after the alert moment, so the timer
    emailed the contact (and now sends the all-clear)."""
    if row["timer_status"] != "armed" or not row["finished_at"] or not row["started_at"]:
        return False
    return datetime.fromisoformat(row["finished_at"]) >= datetime.fromisoformat(timeline(row)["alert_at"])


@app.post("/trips/{trip_id}/checkout")
async def checkout(trip_id: int, c: Checkout) -> dict:
    """Idempotent: a repeat (the phone retrying a check-in it queued without
    signal, or a double tap) records nothing new but re-sends the signal, so a
    check-in whose first signal failed can still stop the timer."""
    first = False
    with closing(db()) as conn:
        trip = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
        if trip is None:
            raise HTTPException(404, "trip not found")
        if trip["status"] != "done":
            now = now_iso()
            # moving time ≈ the clock minus the breaks they planned (never below half)
            moving = max(c.actual_min - (trip["breaks_min"] or 0), c.actual_min * 0.5)
            cur = conn.execute(
                "UPDATE trips SET status='done', finished_at=?, actual_min=?, moving_min=?,"
                " started_at=COALESCE(started_at, ?) WHERE id=? AND status<>'done'",
                (now, c.actual_min, moving, now, trip_id),
            )
            first = cur.rowcount == 1  # a concurrent double tap loses the race here
            if first and trip["crowd_min"] and MIN_TRAIN_MIN <= moving <= MAX_TRAIN_MIN:
                conn.execute(
                    "INSERT INTO personal_hikes(distance_km, climb_m, descent_m, highest_m,"
                    " t_grade, duration_min, crowd_min, source, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (trip["distance_km"], trip["climb_m"], trip["descent_m"], trip["highest_m"],
                     trip["t_grade"], moving, trip["crowd_min"], f"trip:{trip_id}", now),
                )
            conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
        trained = conn.execute(
            "SELECT 1 FROM personal_hikes WHERE source=?", (f"trip:{trip_id}",)
        ).fetchone() is not None
    factor, n = your_pace()
    return {
        **trip_out(row),
        "checkin_signal": await _signal_checkin(row),
        "alert_fired": _alert_fired(row),
        "already_checked_out": not first,
        "trained": trained,
        "your_pace_factor": round(factor, 3),
        "your_pace_hikes": n,
    }


# --- the briefing -----------------------------------------------------------

def _fmt_hm(minutes: float) -> str:
    h, m = divmod(int(round(minutes)), 60)
    return f"{h} h {m:02d} min" if h else f"{m} min"


def _clock(iso: str) -> str:
    return datetime.fromisoformat(iso).astimezone().strftime("%H:%M")


def _briefing_facts(trip) -> str:
    t = timeline(trip)
    breaks = trip["breaks_min"] or 0
    facts = [
        f"Route: {trip['distance_km']} km with {trip['climb_m']} m of climbing, "
        f"high point {trip['highest_m']} m, grade T{trip['t_grade']}.",
        f"Expected moving time {_fmt_hm(trip['expected_min'])}"
        + (f", plus {_fmt_hm(breaks)} of planned breaks." if breaks else "."),
        f"Turn-around rule: if they are not at the top or the far end of the route "
        f"{_fmt_hm(t['turn_around_after_min'])} after starting, they turn around and head back.",
        f"They should be back within {_fmt_hm(t['back_by_after_min'])} of starting — "
        f"9 in 10 similar hikes finish sooner.",
    ]
    if trip["sunset_at"]:
        line = f"Sunset is at {_clock(trip['sunset_at'])}."
        if trip["planned_start"]:
            back_by = datetime.fromisoformat(trip["planned_start"]) + timedelta(minutes=t["back_by_after_min"])
            margin = (datetime.fromisoformat(trip["sunset_at"]) - back_by).total_seconds() / 60
            if margin >= 0:
                line += (f" Starting at {_clock(trip['planned_start'])} as planned leaves "
                         f"{_fmt_hm(margin)} of daylight after that.")
            else:
                line += (f" Starting at {_clock(trip['planned_start'])} as planned, they would finish "
                         f"after dark — tell them to start earlier or choose a shorter route.")
        facts.append(line)
    else:
        facts.append("Sunset time unknown — tell them to aim to be back early rather than inventing a sunset.")
    if trip["rain_pct"] is not None:
        facts.append(f"Rain chance {round(trip['rain_pct'])}%.")
    return " ".join(facts)


@app.post("/trips/{trip_id}/briefing")
def briefing_text(trip_id: int, refresh: bool = False) -> dict:
    """Gemma turns the trip's numbers into a spoken-style briefing. Generated
    once and stored, so the app can prefetch it before the hiker leaves and a
    service restart doesn't lose it. One generation at a time."""
    with _briefing_lock:
        trip = get_trip(trip_id)
        if trip["briefing"] and not refresh:
            return {"briefing": trip["briefing"]}
        prompt = (
            "Write a short spoken briefing for a hiker about to start this trip. "
            "Sound like a friend who hikes, not a robot. 4 to 6 short sentences. "
            "No lists, no markdown, no emoji. Mention the turn-around rule. Facts: "
            + _briefing_facts(trip)
        )
        try:
            r = requests.post(
                f"{GEMMA_BASE_URL}/chat/completions",
                json={
                    "model": GEMMA_MODEL,
                    "stream": False,
                    "temperature": 0.7,
                    "messages": [
                        {"role": "system", "content": "You are Turnaround, a hiking companion. Warm, practical, brief."},
                        {"role": "user", "content": prompt},
                    ],
                },
                timeout=180,
            )
        except requests.RequestException as e:
            raise HTTPException(502, f"gemma unreachable: {e}")
        if r.status_code != 200:
            raise HTTPException(502, f"gemma failed: {r.status_code} {r.text[:200]}")
        content = (r.json().get("choices") or [{}])[0].get("message", {}).get("content")
        if not content or not str(content).strip():
            raise HTTPException(502, "gemma returned no content")
        text = str(content).strip()
        with closing(db()) as conn:
            conn.execute("UPDATE trips SET briefing=? WHERE id=?", (text, trip_id))
            conn.commit()
        return {"briefing": text}


@app.post("/trips/{trip_id}/briefing/audio")
def briefing_audio(trip_id: int):
    """Piper renders the trip's briefing to a wav the hiker plays offline."""
    text = get_trip(trip_id)["briefing"]
    if not text:
        raise HTTPException(409, "generate the briefing text first (POST /trips/{id}/briefing)")
    BRIEFINGS_DIR.mkdir(parents=True, exist_ok=True)
    wav = BRIEFINGS_DIR / f"briefing-trip{trip_id}.wav"
    proc = subprocess.run(
        [PIPER_BIN, "-m", PIPER_VOICE, "-f", str(wav)],
        input=text.encode("utf-8"),
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise HTTPException(502, f"piper failed: {proc.stderr.decode(errors='replace')[:200]}")
    return FileResponse(wav, media_type="audio/wav", filename=wav.name)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
