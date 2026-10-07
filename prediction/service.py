"""Turnaround prediction service — TabPFN hike-time quantiles + trip storage.

Endpoints:
    GET  /health                 -> model/db status
    POST /predict                -> duration quantiles for one hike
    POST /trips                  -> plan a trip (predicts and stores)
    POST /trips/{id}/start       -> hiker set off (Temporal will watch this trip)
    POST /trips/{id}/checkout    -> record the actual time; personalizes future predictions
    GET  /trips                  -> trip history

Fully local: TabPFN weights load from TABPFN_MODEL_PATH (default: the fast
TabPFN v2 checkpoint in data/models/), trips live in a SQLite file. A checked-in
hike becomes an extra training row — TabPFN is in-context, so "retraining" is
just refitting with the new row included.
"""

from __future__ import annotations

import math
import os
import pathlib
import re
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager, closing, suppress
from datetime import datetime, timezone

os.environ.setdefault("TABPFN_ALLOW_CPU_LARGE_DATASET", "1")

import numpy as np
import pandas as pd
import gpxpy
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from tabpfn import TabPFNRegressor

ROOT = pathlib.Path(__file__).resolve().parents[1]
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

_predict_lock = threading.Lock()
_fit_lock = threading.Lock()
_fit_needed = threading.Event()
_state: dict = {"reg": None, "model": "", "training_rows": 0, "personal_rows": 0}

# Plausibility bounds — mirrors build_dataset.py so the model only sees the
# distribution it was trained on, and a fat-fingered checkout can't poison it.
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
        conn.commit()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def training_frame() -> tuple[pd.DataFrame, pd.Series, pd.DataFrame, pd.Series]:
    """Hikr frame and personal frame, kept separate so the serving context
    can always include every personal hike."""
    df = pd.read_csv(DATA)
    Xh, yh = df[FEATURES], df[TARGET]
    with closing(db()) as conn:
        rows = conn.execute(
            f"SELECT {', '.join(FEATURES)}, duration_min FROM personal_hikes"
        ).fetchall()
    _state["personal_rows"] = len(rows)
    if rows:
        Xp = pd.DataFrame([dict(r) for r in rows])[FEATURES]
        yp = pd.Series([r["duration_min"] for r in rows], name=TARGET)
    else:
        Xp = pd.DataFrame(columns=FEATURES)
        yp = pd.Series([], name=TARGET, dtype=float)
    return Xh, yh, Xp, yp


def fit_model() -> None:
    """(Re)fit the serving model. Runs either at startup or in a background
    thread after a checkout. The _fit_needed flag catches checkouts that land
    while a fit is in flight, so the newest personal hike is never skipped."""
    while True:
        if not _fit_lock.acquire(blocking=False):
            return  # a fit is already running; it will loop and pick up our rows
        try:
            _fit_needed.clear()
            t0 = time.time()
            model_path = os.environ.get("TABPFN_MODEL_PATH")
            if not model_path:
                if not DEFAULT_CKPT.exists():
                    raise RuntimeError(
                        f"No TabPFN checkpoint at {DEFAULT_CKPT} and TABPFN_MODEL_PATH is unset"
                    )
                model_path = str(DEFAULT_CKPT)
            Xh, yh, Xp, yp = training_frame()
            # every personal hike stays in context; top up with a random hikr sample
            take = max(0, CONTEXT_ROWS - len(Xp))
            if take < len(Xh):
                Xh = Xh.sample(n=take, random_state=SEED)
                yh = yh.loc[Xh.index]
            X = pd.concat([Xh, Xp], ignore_index=True)
            y = pd.concat([yh, yp], ignore_index=True)
            reg = TabPFNRegressor(
                model_path=model_path, random_state=SEED, n_estimators=N_ESTIMATORS,
            )
            reg.fit(X, y)
            _state.update(reg=reg, model=pathlib.Path(model_path).name, training_rows=len(X))
            print(f"[turnaround] fitted on {len(X)} hikes in {time.time() - t0:.0f}s", flush=True)
        except Exception as e:  # never kill the server from a background refit
            print(f"[turnaround] fit FAILED — serving previous model, if any: {e}", flush=True)
            return
        finally:
            _fit_lock.release()
        if not _fit_needed.is_set():
            return


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
    # Temporal client for the safety timer (workflow starts + check-in signals)
    try:
        from temporalio.client import Client

        _state["temporal"] = await Client.connect(TEMPORAL_ADDRESS)
        print(f"[turnaround] Temporal connected at {TEMPORAL_ADDRESS}", flush=True)
    except Exception as e:
        _state["temporal"] = None
        print(f"[turnaround] Temporal unavailable ({e}) — trips work, timers don't", flush=True)
    yield
    client = _state.get("temporal")
    if client is not None:
        with suppress(Exception):
            await client.close()


app = FastAPI(title="Turnaround prediction service", lifespan=lifespan)
# the React app (Friday) runs on a different port in dev — without this every
# browser fetch dies as an opaque network error
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


@app.get("/health")
def health() -> dict:
    return {
        "status": "ready" if _state["reg"] is not None else "fitting",
        "model": _state["model"],
        "training_rows": _state["training_rows"],
        "personal_rows": _state["personal_rows"],
        "db": str(DB_PATH),
    }


@app.post("/predict")
def predict(f: Features) -> dict:
    return predict_quantiles(f.model_dump())


@app.post("/route/analyze")
async def analyze_route(request: Request, t_grade: int | None = None) -> dict:
    """Analyze an uploaded GPX route (send the file as the raw request body).
    Returns the exact feature dict /predict and /trips expect. The SAC grade
    can't be derived from a track alone — the Plan screen asks the hiker for it."""
    if int(request.headers.get("content-length", "0") or 0) > 10_000_000:
        raise HTTPException(413, "GPX too large (10 MB cap)")
    raw = await request.body()
    try:
        gpx = gpxpy.parse(raw.decode("utf-8", errors="replace"))
    except Exception as e:
        raise HTTPException(400, f"could not parse GPX: {e}")
    length_m = gpx.length_2d() or 0
    up = down = 0.0
    with suppress(Exception):
        up, down = gpx.get_uphill_downhill()
    extremes = gpx.get_elevation_extremes()
    bounds = None
    with suppress(Exception):
        bounds = gpx.get_bounds()
    if length_m <= 0 or bounds is None:
        raise HTTPException(422, "GPX contains no trackpoints")
    lat = lon = None
    if bounds is not None:
        lat = round((bounds.min_latitude + bounds.max_latitude) / 2, 5)
        lon = round((bounds.min_longitude + bounds.max_longitude) / 2, 5)
    if t_grade is not None and not 1 <= t_grade <= 6:
        raise HTTPException(422, "t_grade must be 1-6")
    return {
        "distance_km": round(length_m / 1000, 3),
        "climb_m": round(up or 0.0, 1),
        "descent_m": round(down or 0.0, 1),
        "highest_m": round(extremes.maximum or 0.0, 1),
        "t_grade": t_grade,
        "lat": lat,
        "lon": lon,
    }


class TripCreate(Features):
    name: str = Field(min_length=1, max_length=120)
    contact_email: str | None = None

    @field_validator("name")
    @classmethod
    def _no_control_chars(cls, v: str) -> str:
        # name and email flow into escalation emails later; a newline would
        # smuggle headers the moment nodemailer replaces the outbox
        if CONTROL_CHARS.search(v):
            raise ValueError("name contains control characters")
        return v.strip()

    @field_validator("contact_email")
    @classmethod
    def _valid_email(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if CONTROL_CHARS.search(v) or not EMAIL_RE.match(v):
            raise ValueError("contact_email is not a valid address")
        return v


@app.post("/trips", status_code=201)
def create_trip(t: TripCreate) -> dict:
    pred = predict_quantiles({k: getattr(t, k) for k in FEATURES})
    with closing(db()) as conn:
        cur = conn.execute(
            "INSERT INTO trips(name, distance_km, climb_m, descent_m, highest_m,"
            " t_grade, p5_min, expected_min, p90_min, p95_min, contact_email, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (t.name, t.distance_km, t.climb_m, t.descent_m, t.highest_m,
             t.t_grade, pred["p5_min"], pred["expected_min"], pred["p90_min"],
             pred["p95_min"], t.contact_email, now_iso()),
        )
        conn.commit()
        return {"id": cur.lastrowid, "status": "planned", **pred}


def _iso_ms(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


def _trip_details(row) -> dict:
    """TripDetails for the TS tripWorkflow — key names must match exactly."""
    if not row["started_at"]:
        raise RuntimeError("trip has no start time")
    if not row["contact_email"]:
        raise RuntimeError("trip has no contact email — refusing to arm a timer that alerts nobody")
    started_ms = datetime.fromisoformat(row["started_at"]).timestamp() * 1000
    return {
        "tripId": row["id"],
        "hiker": "Your friend",
        "routeName": row["name"],
        "distanceKm": row["distance_km"],
        "climbM": row["climb_m"],
        "descentM": row["descent_m"],
        "highestM": row["highest_m"],
        "tGrade": row["t_grade"],
        "startedAtIso": row["started_at"],
        "expectedBackIso": _iso_ms(started_ms + row["expected_min"] * 60000),
        "backByIso": _iso_ms(started_ms + row["p90_min"] * 60000),
        "deadlineMs": int(row["p90_min"] * 60000),
        "lateCheckinWindowMs": int(LATE_WINDOW_HOURS * 3600 * 1000),
        "contactEmail": row["contact_email"],
    }


async def _start_timer(row) -> str:
    client = _state.get("temporal")
    if client is None:
        raise RuntimeError("Temporal is unreachable")
    await client.start_workflow(
        "tripWorkflow",
        _trip_details(row),
        id=f"trip-{row['id']}",  # deterministic: one timer per trip
        task_queue=TEMPORAL_TASK_QUEUE,
    )
    return "started"


@app.post("/trips/{trip_id}/start")
async def start_trip(trip_id: int) -> dict:
    with closing(db()) as conn:
        cur = conn.execute(
            "UPDATE trips SET status='active', started_at=? WHERE id=? AND status='planned'",
            (now_iso(), trip_id),
        )
        if cur.rowcount == 0:
            row = conn.execute("SELECT status FROM trips WHERE id=?", (trip_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "trip not found")
            raise HTTPException(409, f"trip is {row['status']}, only planned trips can start")
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    # the trip is real; the timer is the promise. if Temporal is down, say so
    # loudly instead of pretending the hiker is covered
    timer = "started"
    try:
        await _start_timer(row)
    except Exception as e:
        timer = f"failed: {e}"
    return {**dict(row), "safety_timer": timer}


class Checkout(BaseModel):
    actual_min: float = Field(gt=0, le=1500, description="recorded moving time in minutes (25 h cap — a garbage value would poison every future prediction)")


@app.post("/trips/{trip_id}/checkout")
async def checkout(trip_id: int, c: Checkout) -> dict:
    with closing(db()) as conn:
        # conditional transition: a double-clicked button can't double-insert
        # the hike into the training set, and the whole thing stays atomic
        now = now_iso()
        cur = conn.execute(
            "UPDATE trips SET status='done', finished_at=?, actual_min=?,"
            " started_at=COALESCE(started_at, ?) WHERE id=? AND status<>'done'",
            (now, c.actual_min, now, trip_id),
        )
        if cur.rowcount == 0:
            exists = conn.execute("SELECT 1 FROM trips WHERE id=?", (trip_id,)).fetchone()
            if exists is None:
                raise HTTPException(404, "trip not found")
            raise HTTPException(409, "trip already checked out")
        trip = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
        conn.execute(
            "INSERT INTO personal_hikes(distance_km, climb_m, descent_m, highest_m,"
            " t_grade, duration_min, created_at) VALUES(?,?,?,?,?,?,?)",
            (trip["distance_km"], trip["climb_m"], trip["descent_m"], trip["highest_m"],
             trip["t_grade"], c.actual_min, now_iso()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    # tell the safety timer "I'm out" — it may already be gone (escalated);
    # the recorded time above is what feeds the model either way
    client = _state.get("temporal")
    if client is not None:
        with suppress(Exception):
            await client.get_workflow_handle(f"trip-{trip_id}").signal("trip.checkedIn")
    _fit_needed.set()
    threading.Thread(target=fit_model, daemon=True).start()
    return dict(row)


@app.get("/trips")
def list_trips() -> list[dict]:
    with closing(db()) as conn:
        rows = conn.execute("SELECT * FROM trips ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@app.post("/trips/{trip_id}/briefing")
def briefing_text(trip_id: int) -> dict:
    """Gemma 4 turns the trip's numbers into a spoken-style briefing."""
    with closing(db()) as conn:
        trip = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    if trip is None:
        raise HTTPException(404, "trip not found")
    prompt = (
        "Write a short spoken briefing for a hiker about to start this trip. "
        "Sound like a friend who hikes, not a robot. 4 to 6 short sentences. "
        "No lists, no markdown, no emoji. Mention the turn-back rule. Facts: "
        f"Route: {trip['distance_km']} km with {trip['climb_m']} m of climbing, "
        f"high point {trip['highest_m']} m, grade T{trip['t_grade']}. "
        f"Expected moving time {round(trip['expected_min'])} minutes; the hard "
        f"turn-back rule is {round(trip['p90_min'])} minutes after they start — "
        f"if they are not nearly back by then, they turn around."
    )
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
    if r.status_code != 200:
        raise HTTPException(502, f"gemma failed: {r.status_code} {r.text[:200]}")
    content = (r.json().get("choices") or [{}])[0].get("message", {}).get("content")
    if not content or not str(content).strip():
        raise HTTPException(502, "gemma returned no content")
    text = str(content).strip()
    _state.setdefault("briefings", {})[trip_id] = text
    return {"briefing": text}


@app.post("/trips/{trip_id}/briefing/audio")
def briefing_audio(trip_id: int):
    """Piper renders the trip's briefing to a wav the hiker plays offline."""
    text = _state.get("briefings", {}).get(trip_id)
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
