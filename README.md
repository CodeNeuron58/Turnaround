# Turnaround

An open-source hiking companion. It predicts how long your hike will take, tells you when to turn around, and quietly alerts someone you trust if you don't check in.

Built for the [Hacktoberfest Open-Source AI Challenge: Week 1](https://dev.to/challenges/hacktoberfest-week1-2026-10-05) on DEV — theme: **Touch Grass**.

## What it does

- **Predict** — TabPFN, in context on 7,186 real hikes from hikr.org, estimates your moving time as a range. A personal pace factor — your finished hikes against the crowd's estimate for the same routes — tunes it to you from your first check-in. Your planned breaks are added on top.
- **Turn around** — three moments per trip: *turn around by* (not at the top or the far end by then? head back), *back by* (the 90th percentile — 9 in 10 hikes like yours finish sooner), checked against sunset.
- **Brief** — Gemma 4, running on your own machine, turns the numbers into a plain-language briefing, spoken aloud with Piper and saved to your phone before you leave.
- **Watch** — a Temporal safety timer waits for your check-in. If you're still out well past your back-by time (the 95th percentile + breaks + 30 min), it emails your contact the plan, the route, and a map link to where you set off — even if the server restarts mid-trip. Check in late and they get an all-clear.

## Components

| Folder | Role | Stack |
|---|---|---|
| [`app/`](app/) | Plan / On-trail / Summary screens | React + Vite |
| [`agent/`](agent/) | Trip-planning agent and briefing (CLI) | Plain TypeScript + Gemma 4 + Piper |
| [`workflows/`](workflows/) | Safety timer, alert and all-clear emails | Temporal |
| [`prediction/`](prediction/) | Hike-time prediction service and trip storage | Python + TabPFN + SQLite |
| [`data/`](data/) | Training data (hikr.org) and notes | — |
| [`docs/evidence/`](docs/evidence/) | Scenario proof for the safety timer | — |

## Run it

Everything runs on one machine — no cloud account needed. First-time setup:

1. Node 20+ and Python 3.11 · `npm install` at the repo root
2. Python deps: `python -m venv .venv` then `.venv\Scripts\pip install -r prediction\requirements.txt`
3. Gemma 4: install [Ollama](https://ollama.com), then `ollama pull gemma4:e4b`
4. Piper + Temporal binaries: one-time fetch commands in [tools/README.md](tools/README.md)
5. Training data: download the dataset per [data/DATA_NOTES.md](data/DATA_NOTES.md), then `python prediction/build_dataset.py`
6. Optional: your own past hikes → `data/raw/gpx/`, then `.venv\Scripts\python.exe prediction\import_hikes.py --grade 3` (one run per grade) to seed your pace factor

Then one process per terminal:

| Terminal | Command |
|---|---|
| Temporal server | `tools\temporal\temporal.exe server start-dev --port 7233 --db-filename tools\temporal\turnaround.db` |
| Prediction service | `.venv\Scripts\python.exe -m uvicorn prediction.service:app --port 8000` |
| Safety-timer worker | `npm run worker -w @turnaround/workflows` |
| **The app (three screens)** | `npm run dev -w @turnaround/app` → open http://localhost:5173 |

`--db-filename` keeps running timers on disk, so they survive a restart of the Temporal server
itself (a Windows Update reboot included), not just of the worker.

Plan a hike in the app — Start arms the Temporal timer, the trail screen speaks the
briefing, and "I'm out" checks you in. The agent CLI
(`npx tsx agent/src/cli.ts --gpx data/test-route.gpx --grade 3`) runs the same
plan from a terminal; curl recipes live in [workflows/README.md](workflows/README.md).

## Taking it on the trail

The laptop is the server, so your phone has to reach it from the trail:

- **Same Wi-Fi** works out of the box (Vite prints a `Network:` URL).
- **On mobile data**, put the laptop and phone on a private network — e.g.
  [Tailscale](https://tailscale.com) on both, then open `http://<laptop's Tailscale IP or name>:5173`
  on the phone. Nothing is exposed to the internet. Don't use a public tunnel: the app has no login.
- **Keep the laptop awake and online** for the whole hike — it runs the timer and sends the email.
  Plugged in: `powercfg /change standby-timeout-ac 0` (restore later with your usual value).
- **Plan while you have signal.** The briefing and its audio are saved to the phone when you plan.
  On the trail, keep the tab open: with no signal, "I'm out" is saved on the phone and sent the
  moment it can reach the laptop. (A page *reload* needs signal — there's no offline web cache.)

**Missed-check-in drill:** open the app as `http://…:5173/?drill=120` — the contact is emailed
120 s after Start (both emails are marked `[DRILL]`), and checking in afterwards sends the all-clear.

Starting fresh: stop everything, then delete `data/trips.db` **and** `tools/temporal/turnaround.db`
together — trip ids restart at 1, and a leftover timer would carry an old trip's id.

## Why open source

It runs on your own machine — no server, no subscription — so your location data never leaves it, and every model in the stack is swappable.

## License

[MIT](LICENSE)
