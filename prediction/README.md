# prediction

TabPFN hike-time prediction service (Python).

- Trains on the hikr.org dataset plus personal GPX history
- Features: distance, climb, descent, highest point, difficulty
- Serves the likely duration **and the 90th-percentile worst case** — the worst case sets the turn-back time and the alarm
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
```

- `TABPFN_MODEL_PATH` — path to a local TabPFN `.ckpt` to skip the HuggingFace
  download (pinned weights, offline use). The checkpoint itself is not committed.
- On CPU, datasets above 1,000 samples require `TABPFN_ALLOW_CPU_LARGE_DATASET=1`;
  `evaluate.py` sets this itself.

The service runs on the same machine as Gemma 4 (Ollama) — one box, and nothing
about a hiker's route or location ever leaves it.
