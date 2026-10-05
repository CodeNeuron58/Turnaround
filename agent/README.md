# agent

The trip-planning agent — plain TypeScript, no framework. It talks to Gemma 4 over its
OpenAI-compatible endpoint with `fetch`, and has four abilities:

1. Read a route (GPX / OpenStreetMap)
2. Get weather and sunset (Open-Meteo)
3. Call the TabPFN prediction service
4. Calculate the turn-back time

Gemma 4 — running locally via Ollama on the same machine — turns the numbers into a
plain-language briefing ("advice from a friend, not a report"), and Piper renders it as speech.
