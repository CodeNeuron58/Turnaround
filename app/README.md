# app

The Turnaround web app — three screens, mobile-friendly, no UI framework:

- **Plan** — upload a GPX route, pick the grade, set the start time and an
  emergency contact. The screen shows the TabPFN prediction band, the
  turn-back time (the P90 estimate), and the sunset margin.
- **On trail** — the countdown to your turn-back time, the Gemma-written
  briefing with a Piper-rendered audio player (cached in localStorage, so no
  signal on the trail is survivable), and the big **I'm out** button.
- **I'm out** — predicted vs actual, and confirmation that your check-in
  reached the safety timer. The hike immediately joins the model's context.

## Run

```bash
npm run dev -w @turnaround/app     # → http://localhost:5173
```

`/api` proxies to the prediction service on port 8000 (see `vite.config.ts`).
The Start button arms the Temporal workflow (`trip-<id>`) through the service —
one hiker, one timer, guaranteed by the deterministic workflow id.
