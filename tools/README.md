# tools

Local binaries and models for Turnaround. **Nothing in this folder is committed** —
it's all re-fetchable with the commands below (network note: use IPv4; see README
troubleshooting — `curl -4`).

## Piper TTS (open-source text-to-speech)

```bash
mkdir -p piper/voice
# binary (Windows amd64)
curl -4L https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip -o piper.zip
unzip piper.zip -d piper-bin
# voice: en_US "amy", medium quality
curl -4L "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx" -o piper/voice/en_US-amy-medium.onnx
curl -4L "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json" -o piper/voice/en_US-amy-medium.onnx.json
```

## Temporal server (safety timer)

```bash
curl -4L https://github.com/temporalio/cli/releases/download/v1.9.1/temporal_cli_1.9.1_windows_amd64.zip -o temporal-cli.zip
unzip temporal-cli.zip -d temporal
temporal/temporal.exe server start-dev --port 7233 --db-filename temporal/turnaround.db
```

`--db-filename` persists running timers to disk, so a restart of the Temporal server (or the
laptop) doesn't drop them. Delete `turnaround.db` together with `data/trips.db` when starting fresh.

## The briefing pipeline (proven working, Oct 6)

1. **Gemma 4** (Ollama, `gemma4:e4b`) turns trip facts into a spoken-style briefing.
   **Use the HTTP API, not the CLI** — `ollama run` hangs on this network (tries to
   phone home over IPv6). The agent calls `POST {GEMMA_BASE_URL}/chat/completions`
   with `"stream": false` (OpenAI-compatible endpoint).
2. **Piper** turns the text into audio:

```bash
piper-bin/piper/piper.exe -m piper/voice/en_US-amy-medium.onnx -f briefing.wav < briefing.txt
```

Real-time factor ≈ 0.17 — a 30-second briefing synthesizes in ~5 s.

First-run outputs from this pipeline are committed under `docs/evidence/`.

