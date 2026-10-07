# prediction

TabPFN hike-time prediction service (Python).

- TabPFN, in context on the hikr.org dataset, predicts moving time as quantiles (P5 / P50 / P90 / P95)
- Features: distance, climb, descent, highest point, difficulty
- A **personal pace factor** tunes the crowd's estimate to you: each finished hike's moving time over
  the crowd's median for that route, geometric-mean'd and shrunk toward 1.0 while history is thin
  (one hike moves you a third of the way). Hikes under 15 min of moving time are never learned from.
  Why not just add your hikes to TabPFN's context: measured, three of them moved the median by <1%
  against 2,000 strangers' hikes.
- Every trip moment comes from one function: turn around by (Naismith's outbound share of the
  back-by time), back by (P90 + breaks), alert (P95 + breaks + `ALERT_GRACE_MIN`, default 30)
- A Naismith's-rule baseline is kept alongside for honest comparison

## Setup

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows
```

## Run

```bash
# 1) raw Kaggle CSV -> training table (see data/DATA_NOTES.md)
python prediction/build_dataset.py

# 2) TabPFN vs Naismith's rule on held-out hikes
python prediction/evaluate.py

# 3) the service the app talks to (see service.py's docstring for endpoints)
python -m uvicorn prediction.service:app --port 8000

# 4) optional: seed your pace factor from past hikes (GPX with timestamps)
python prediction/import_hikes.py --grade 3 data/raw/gpx
```

- `TABPFN_MODEL_PATH` — path to a local TabPFN `.ckpt` to skip the HuggingFace
  download (pinned weights, offline use). The checkpoint itself is not committed.
- On CPU, datasets above 1,000 samples require `TABPFN_ALLOW_CPU_LARGE_DATASET=1`;
  `evaluate.py` sets this itself.

The service runs on the same machine as Gemma 4 (Ollama) — one box, and nothing
about a hiker's route or location ever leaves it.
