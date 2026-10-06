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

import os
import pathlib
import sqlite3
import threading
import time
from contextlib import asynccontextmanager, closing, suppress
from datetime import datetime, timezone

os.environ.setdefault("TABPFN_ALLOW_CPU_LARGE_DATASET", "1")

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
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
_state: dict = {"reg": None, "model": "", "training_rows": 0, "personal_rows": 0}

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
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


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
    if not _fit_lock.acquire(blocking=False):
        return  # a refit is already running
    try:
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
    finally:
        _fit_lock.release()


@asynccontextmanager
async def lifespan(_: FastAPI):
    fit_model()
    yield


app = FastAPI(title="Turnaround prediction service", lifespan=lifespan)


class Features(BaseModel):
    distance_km: float = Field(gt=0, description="route length in km")
    climb_m: float = Field(ge=0)
    descent_m: float = Field(ge=0)
    highest_m: float = Field(ge=0)
    t_grade: int = Field(ge=1, le=6, description="SAC scale T1-T6")


def predict_quantiles(features: dict) -> dict:
    reg = _state["reg"]
    if reg is None:
        raise HTTPException(503, "model is still fitting, try again shortly")
    X = pd.DataFrame([features])[FEATURES]
    with _predict_lock:
        q = np.asarray(reg.predict(X, output_type="quantiles", quantiles=QUANTILES))
    if q.shape != (1, len(QUANTILES)):
        if q.shape == (len(QUANTILES), 1):
            q = q.T
        else:
            raise ValueError(f"unexpected quantile shape {q.shape}")
    p05, p50, p90, p95 = (float(max(v, 1.0)) for v in q[0])
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


class TripCreate(Features):
    name: str
    contact_email: str | None = None


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


@app.post("/trips/{trip_id}/start")
def start_trip(trip_id: int) -> dict:
    with closing(db()) as conn:
        cur = conn.execute(
            "UPDATE trips SET status='active', started_at=? WHERE id=? AND status='planned'",
            (now_iso(), trip_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "trip not found or already started")
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    return dict(row)


class Checkout(BaseModel):
    actual_min: float = Field(gt=0, description="recorded moving time in minutes")


@app.post("/trips/{trip_id}/checkout")
def checkout(trip_id: int, c: Checkout) -> dict:
    with closing(db()) as conn:
        trip = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
        if trip is None:
            raise HTTPException(404, "trip not found")
        if trip["status"] == "done":
            raise HTTPException(409, "trip already checked out")
        conn.execute(
            "UPDATE trips SET status='done', finished_at=?, actual_min=? WHERE id=?",
            (now_iso(), c.actual_min, trip_id),
        )
        conn.execute(
            "INSERT INTO personal_hikes(distance_km, climb_m, descent_m, highest_m,"
            " t_grade, duration_min, created_at) VALUES(?,?,?,?,?,?,?)",
            (trip["distance_km"], trip["climb_m"], trip["descent_m"], trip["highest_m"],
             trip["t_grade"], c.actual_min, now_iso()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    # the checked-in hike is now a training row — refit in the background so the
    # next prediction is a little more personal
    threading.Thread(target=fit_model, daemon=True).start()
    return dict(row)


@app.get("/trips")
def list_trips() -> list[dict]:
    with closing(db()) as conn:
        rows = conn.execute("SELECT * FROM trips ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
