# Turnaround

An open-source hiking companion. It predicts how long your hike will take, tells you when to turn back, and quietly alerts someone you trust if you don't check in.

Built for the [Hacktoberfest Open-Source AI Challenge: Week 1](https://dev.to/challenges/hacktoberfest-week1-2026-10-05) on DEV — theme: **Touch Grass**.

## What it does

- **Predict** — TabPFN estimates your hike duration as a range; the 90th-percentile worst case sets the turn-back time and the sunset margin.
- **Brief** — Gemma 4, running on infrastructure you control, turns the numbers into a plain-language briefing, spoken aloud with Piper.
- **Watch** — a Temporal safety timer waits for your check-in and emails your emergency contact the plan, route, and expected return if you're overdue — even if the server restarts mid-trip.

## Components

| Folder | Role | Stack |
|---|---|---|
| [`app/`](app/) | Plan / On-trail / I'm-out screens *(being built next)* | React + Vite |
| [`agent/`](agent/) | Trip-planning agent and briefing | Plain TypeScript + Gemma 4 + Piper |
| [`workflows/`](workflows/) | Safety timer and escalation | Temporal |
| [`prediction/`](prediction/) | Hike-time prediction service | Python + TabPFN |
| [`data/`](data/) | Training data (hikr.org + personal GPX) | — |
| [`docs/evidence/`](docs/evidence/) | Scenario proof for the safety timer | — |

## Run it

Everything runs on one machine — no cloud account needed. First-time setup:

1. Node 20+ and Python 3.11 · `npm install` at the repo root
2. Python deps: `python -m venv .venv` then `.venv\Scripts\pip install -r prediction\requirements.txt`
3. Gemma 4: install [Ollama](https://ollama.com), then `ollama pull gemma4:e4b`
4. Piper + Temporal binaries: one-time fetch commands in [tools/README.md](tools/README.md)
5. Training data: download the dataset per [data/DATA_NOTES.md](data/DATA_NOTES.md), then `python prediction/build_dataset.py`

Then one process per terminal:

| Terminal | Command |
|---|---|
| Temporal server | `tools\temporal\temporal.exe server start-dev --port 7233` |
| Prediction service | `.venv\Scripts\python.exe -m uvicorn prediction.service:app --port 8000` |
| Safety-timer worker | `npm run worker -w @turnaround/workflows` |

Plan + start a trip through the API (curl recipes in [workflows/README.md](workflows/README.md)), or run the agent end-to-end:

```bash
npx tsx agent/src/cli.ts --gpx data/test-route.gpx --grade 3
```

## Why open source

It runs on your own machine — no server, no subscription — so your location data never leaves it, and every model in the stack is swappable.

## Status

🚧 Work in progress.

## License

[MIT](LICENSE)
