"""Evaluate TabPFN vs Naismith's rule on held-out hikr.org hikes.

The numbers printed and saved here are the backbone of the DEV post:
- average error (MAE) of each method
- how often the actual hike time lands inside TabPFN's 90% band (P5-P95)
- how often hikers finish before P90 — the number that sets the turn-back alarm

Output: prediction/results/eval_results.json + eval_summary.md
"""

from __future__ import annotations

import json
import os
import pathlib
import socket
import time

# Evaluation runs on CPU with ~6k training samples; TabPFN's CPU guard is meant
# for interactive use. This is a deliberate one-off batch job.
os.environ.setdefault("TABPFN_ALLOW_CPU_LARGE_DATASET", "1")

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from tabpfn import TabPFNRegressor

# huggingface.co is unreachable over IPv6 on this network (SSL resets mid-handshake),
# and Python prefers IPv6 by default. Prefer IPv4 for all lookups in this process.
_orig_getaddrinfo = socket.getaddrinfo

def _prefer_ipv4(*args, **kwargs):
    results = _orig_getaddrinfo(*args, **kwargs)
    return [r for r in results if r[0] == socket.AF_INET] or results

socket.getaddrinfo = _prefer_ipv4

DATA = pathlib.Path("data/processed/hikes.csv")
RESULTS = pathlib.Path("prediction/results")
FEATURES = ["distance_km", "climb_m", "descent_m", "highest_m", "t_grade"]
TARGET = "duration_min"
SEED = 42
QUANTILES = [0.05, 0.5, 0.9, 0.95]


def naismith_min(dist_km: pd.Series, climb_m: pd.Series) -> pd.Series:
    """Naismith's rule: 1 h per 5 km of distance + 1 h per 600 m of ascent."""
    return dist_km * 12.0 + climb_m * 0.1


def mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(y_true - y_pred)))


def rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def build_regressor() -> TabPFNRegressor:
    """Build the regressor, optionally from local weights (TABPFN_MODEL_PATH)
    so evaluation runs offline when huggingface.co is unreachable."""
    model_path = os.environ.get("TABPFN_MODEL_PATH")
    if model_path:
        return TabPFNRegressor(model_path=model_path, random_state=SEED)
    return TabPFNRegressor(random_state=SEED)


def main() -> None:
    df = pd.read_csv(DATA)
    X, y = df[FEATURES], df[TARGET]
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=SEED,
    )
    y_te = y_te.to_numpy()

    nai = naismith_min(X_te["distance_km"], X_te["climb_m"]).to_numpy()

    t0 = time.time()
    reg = build_regressor()
    reg.fit(X_tr, y_tr)
    q = np.asarray(reg.predict(X_te, output_type="quantiles", quantiles=QUANTILES))
    if q.shape != (len(X_te), len(QUANTILES)):
        if q.shape == (len(QUANTILES), len(X_te)):
            q = q.T
        else:
            raise ValueError(f"unexpected quantile shape {q.shape}")
    q = np.clip(q, 1.0, None)
    p05, p50, p90, p95 = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    elapsed = time.time() - t0

    results = {
        "n_train": len(X_tr),
        "n_test": len(X_te),
        "features": FEATURES,
        "target": TARGET,
        "seed": SEED,
        "mae_min": {"tabpfn": mae(y_te, p50), "naismith": mae(y_te, nai)},
        "rmse_min": {"tabpfn": rmse(y_te, p50), "naismith": rmse(y_te, nai)},
        "coverage_p05_p95_pct": float(np.mean((y_te >= p05) & (y_te <= p95)) * 100),
        "finished_before_p90_pct": float(np.mean(y_te <= p90) * 100),
        "band_width_mean_min": float(np.mean(p95 - p05)),
        "tabpfn_fit_predict_seconds": round(elapsed, 1),
    }

    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "eval_results.json").write_text(json.dumps(results, indent=2))

    md = f"""# TabPFN vs Naismith's rule — {results['n_test']} held-out hikr.org hikes

| Metric | TabPFN | Naismith |
|---|---|---|
| Average error (MAE, min) | **{results['mae_min']['tabpfn']:.1f}** | {results['mae_min']['naismith']:.1f} |
| RMSE (min) | **{results['rmse_min']['tabpfn']:.1f}** | {results['rmse_min']['naismith']:.1f} |

- Actual time inside the TabPFN 90% band (P5-P95): **{results['coverage_p05_p95_pct']:.1f}%**
- Hikers who finished before P90 (the turn-back alarm): **{results['finished_before_p90_pct']:.1f}%**
- Mean 90% band width: {results['band_width_mean_min']:.0f} min
- Seed {SEED}, features: {', '.join(FEATURES)}
"""
    (RESULTS / "eval_summary.md").write_text(md)

    print(md)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
