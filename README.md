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
| [`app/`](app/) | Plan / On-trail / I'm-out screens | React + Vite |
| [`agent/`](agent/) | Trip-planning agent and briefing | Plain TypeScript + Gemma 4 + Piper |
| [`workflows/`](workflows/) | Safety timer and escalation | Temporal |
| [`prediction/`](prediction/) | Hike-time prediction service | Python + TabPFN |
| [`data/`](data/) | Training data (hikr.org + personal GPX) | — |
| [`docs/`](docs/) | Architecture diagram and notes | — |

## Why open source

It runs on a server you control, your location data never leaves your infrastructure, and every model and service in the stack is swappable.

## Status

🚧 Work in progress.

## License

[MIT](LICENSE)
