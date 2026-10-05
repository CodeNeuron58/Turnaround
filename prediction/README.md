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

The service runs on the same DigitalOcean GPU Droplet as Gemma 4.
