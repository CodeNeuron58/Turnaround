// Turnaround trip-planning agent — plain TypeScript, no framework, zero deps.
//
// Four abilities:
//   1. read a route        -> prediction service  POST /route/analyze
//   2. get weather+sunset  -> Open-Meteo (plain fetch)
//   3. predict hike time   -> prediction service  POST /predict (TabPFN)
//   4. compute turn-back   -> start + P90 estimate vs sunset
// Then Gemma 4 (local Ollama) writes the spoken briefing and Piper renders it.
//
// Every call is localhost or a free open API; nothing about the hiker leaves
// the machine except the anonymous weather request (coordinates only, no id).

import dns from "node:dns";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// This network's IPv6 path is broken for several hosts (HuggingFace, Ollama's
// update check) — prefer IPv4 for every lookup, same fix as the python side.
dns.setDefaultResultOrder("ipv4first");

try {
  process.loadEnvFile(); // no-op failure if there's no .env — defaults below are fine
} catch {
  /* no .env, use defaults */
}

const SERVICE = process.env.PREDICTION_SERVICE_URL ?? "http://127.0.0.1:8000";
const GEMMA = process.env.GEMMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
const GEMMA_MODEL = process.env.GEMMA_MODEL ?? "gemma4:e4b";
const PIPER_BIN = process.env.PIPER_BIN ?? "tools/piper-bin/piper/piper.exe";
const PIPER_VOICE = process.env.PIPER_VOICE ?? "tools/piper/voice/en_US-amy-medium.onnx";

export interface Features {
  distance_km: number;
  climb_m: number;
  descent_m: number;
  highest_m: number;
  t_grade: number;
}

export interface Route extends Features {
  lat: number | null;
  lon: number | null;
}

/** Ability 1 — read a route: upload the GPX to the service, get back the exact
 *  feature dict the prediction model expects (plus midpoint for weather). */
export async function readRoute(gpxPath: string, tGrade?: number): Promise<Route> {
  const body = await readFile(gpxPath);
  const url = `${SERVICE}/route/analyze${tGrade ? `?t_grade=${tGrade}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/gpx+xml" },
  });
  if (!res.ok) throw new Error(`route analyze failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Ability 2 — get weather and sunset for the route's area on the hike date. */
export async function getWeather(lat: number, lon: number, date: string) {
  if (lat == null || lon == null) {
    return { sunset: null, rainChancePct: null, tempMaxC: null };
  }
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("daily", "sunset,precipitation_probability_max,temperature_2m_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("start_date", date);
  u.searchParams.set("end_date", date);
  const res = await fetch(u);
  if (!res.ok) throw new Error(`open-meteo failed: ${res.status} ${await res.text()}`);
  const d = await res.json();
  return {
    sunset: d.daily.sunset[0] as string,
    rainChancePct: (d.daily.precipitation_probability_max?.[0] ?? null) as number | null,
    tempMaxC: (d.daily.temperature_2m_max?.[0] ?? null) as number | null,
  };
}

/** Ability 3 — call the TabPFN prediction service. */
export async function predictHike(f: Features) {
  const res = await fetch(`${SERVICE}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(f),
  });
  if (!res.ok) throw new Error(`predict failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    p5_min: number;
    expected_min: number;
    p90_min: number;
    p95_min: number;
  };
}

/** Ability 4 — the turn-back rule: when the cautious (P90) estimate says you'd
 *  still make it down, expressed against sunset. */
export function computeTurnBack(startIso: string, p90Min: number, sunsetIso: string | null) {
  const start = new Date(startIso);
  const backBy = new Date(start.getTime() + p90Min * 60_000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const result: { backBy: string; sunset: string | null; marginMin: number | null; afterDark: boolean } = {
    backBy: fmt(backBy),
    sunset: sunsetIso,
    marginMin: null,
    afterDark: false,
  };
  if (sunsetIso) {
    result.marginMin = Math.round((new Date(sunsetIso).getTime() - backBy.getTime()) / 60_000);
    result.afterDark = result.marginMin < 0;
  }
  return result;
}

/** Gemma 4 turns the numbers into a briefing that reads like a friend who hikes. */
export async function writeBriefing(facts: Record<string, unknown>): Promise<string> {
  const prompt = `Write a short spoken briefing for a hiker about to start this trip.
Sound like a friend who hikes, not a robot. 4 to 6 short sentences.
No lists, no markdown, no emoji. Weave in the turn-back time and the sunset
margin naturally. Facts: ${JSON.stringify(facts)}`;
  const res = await fetch(`${GEMMA}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      messages: [
        { role: "system", content: "You are Turnaround, a hiking companion. Warm, practical, brief." },
        { role: "user", content: prompt },
      ],
      stream: false,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`gemma failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return String(data.choices[0].message.content).trim();
}

/** Piper renders the briefing to a wav the hiker can play offline on the trail. */
export function speakBriefing(text: string, outWav: string): string {
  const r = spawnSync(PIPER_BIN, ["-m", PIPER_VOICE, "-f", outWav], {
    input: text,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`piper failed: ${r.stderr}`);
  return outWav;
}

/** The whole flow: route -> weather -> prediction -> turn-back -> briefing. */
export async function planTrip(opts: {
  gpxPath: string;
  tGrade?: number;
  startIso: string;
  speakWav?: string;
}) {
  const route = await readRoute(opts.gpxPath, opts.tGrade);
  const date = opts.startIso.slice(0, 10);
  const [weather, prediction] = await Promise.all([
    getWeather(route.lat ?? 0, route.lon ?? 0, date),
    predictHike(route),
  ]);
  const turnBack = computeTurnBack(opts.startIso, prediction.p90_min, weather.sunset);
  const briefing = await writeBriefing({
    ...route,
    ...prediction,
    ...weather,
    ...turnBack,
    start: opts.startIso,
  });
  const wav = opts.speakWav ? speakBriefing(briefing, opts.speakWav) : undefined;
  return { route, prediction, weather, turnBack, briefing, wav };
}
