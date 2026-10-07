# agent

The trip-planning agent — **plain TypeScript, no framework, zero runtime dependencies**.
It talks to local services over HTTP and to Gemma 4 through Ollama's OpenAI-compatible
endpoint. Everything runs on one machine.

## The four abilities

1. **Read a route** — GPX file → prediction service `POST /route/analyze` (returns the
   exact features the model expects, plus the track midpoint for weather)
2. **Get weather + sunset** — Open-Meteo (plain fetch, coordinates only, nothing personal)
3. **Predict hike time** — TabPFN via `POST /predict` (median + P90 + band)
4. **Compute the turn-around** — back by = start + P90 + planned breaks; turn around by =
   Naismith's outbound share of that (the same rule as the service); margin against sunset

Then **Gemma 4** writes a spoken-style briefing from the numbers, and **Piper** renders
it to a wav the hiker can play offline on the trail.

## Run

```bash
npx tsx agent/src/cli.ts --gpx data/test-route.gpx --grade 3 --start "2026-10-10T07:30" --breaks 30
```

- `--grade` is the SAC T1–T6 difficulty (a track alone can't imply it)
- artifacts land in `agent/output/` (gitignored): `plan.json`, `briefing.txt`, `briefing.wav`
- config via `.env` (copy `.env.example`) — all defaults work on a single machine

The same four abilities are exported from `src/agent.ts` as plain functions. The app
gets the same answers from the prediction service, which implements the same rules.
