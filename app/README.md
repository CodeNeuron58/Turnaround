# app

The Turnaround web app — three screens, mobile-friendly, no UI framework:

- **Plan** — upload a GPX route, pick the grade, set the start time, planned
  breaks, your name and an emergency contact. The screen shows the moving-time
  band (tuned to your pace once you have history), the **turn-around** time,
  the **back-by** time (P90 + breaks), and the sunset margin. The briefing and
  its audio are prepared and saved to the phone right here, while there's signal.
- **On trail** — a ring that counts down to turn-around, then to back-by, then
  to the alert; the briefing and audio from the phone's storage; the safety
  timer's real state (a red banner with a retry if it failed to arm); and the
  big **I'm out** button. With no signal, the check-in is saved on the phone
  and sent as soon as it can reach the laptop. A refreshed or discarded tab
  comes back to this screen.
- **Summary** — predicted vs actual (breaks included on both sides), whether
  anyone was alerted, and your pace factor after this hike.

## Run

```bash
npm run dev -w @turnaround/app     # → http://localhost:5173
```

`/api` proxies to the prediction service on port 8000 (see `vite.config.ts`).
The Start button arms the Temporal workflow (`trip-<id>`) through the service —
one hiker, one timer, guaranteed by the deterministic workflow id. Add
`?drill=120` to the URL for a missed-check-in drill (alert 120 s after Start).
Reaching the app from your phone on the trail: see the root README.
