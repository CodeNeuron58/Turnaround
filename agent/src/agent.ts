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
// Failure philosophy: the route and the prediction ARE the product — weather
// and the briefing are enhancements, so they degrade instead of aborting.

import dns from "node:dns";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// This network's IPv6 path is broken for several hosts (HuggingFace, Ollama's
// update check) — prefer IPv4 for every lookup, same fix as the python side.
dns.setDefaultResultOrder("ipv4first");

try {
  process.loadEnvFile(); // throws silently ignored if there's no .env
} catch {
  /* no .env, use defaults */
}

// anchored to the repo root so relative defaults work from any cwd
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SERVICE = process.env.PREDICTION_SERVICE_URL || "http://127.0.0.1:8000";
const GEMMA = process.env.GEMMA_BASE_URL || "http://127.0.0.1:11434/v1";
const GEMMA_MODEL = process.env.GEMMA_MODEL || "gemma4:e4b";
const PIPER_BIN = process.env.PIPER_BIN || path.join(ROOT, "tools", "piper-bin", "piper", "piper.exe");
const PIPER_VOICE = process.env.PIPER_VOICE || path.join(ROOT, "tools", "piper", "voice", "en_US-amy-medium.onnx");

// TabPFN's first inference after a service restart is slow; Ollama may load a
// cold model — the timeouts are generous where slowness is expected
const SERVICE_TIMEOUT_MS = 180_000;
const WEATHER_TIMEOUT_MS = 10_000;
const GEMMA_TIMEOUT_MS = 180_000;

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

export interface Weather {
  ok: boolean; // false = we could not get a trustworthy sunset; the briefing says so
  sunset: string | null; // location-local wall clock, as returned by Open-Meteo
  sunsetEpochMs: number | null; // absolute instant, corrected by the location's UTC offset
  rainChancePct: number | null;
  tempMaxC: number | null;
  error?: string;
}

function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function badResponse(endpoint: string, status: number, body: unknown): Error {
  const snippet = typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body)?.slice(0, 200);
  return new Error(`${endpoint} failed: ${status} ${snippet}`);
}

/** Ability 1 — read a route: upload the GPX to the service, get back the exact
 *  feature dict the prediction model expects (plus midpoint for weather). */
export async function readRoute(gpxPath: string, tGrade?: number): Promise<Route> {
  const body = await readFile(gpxPath);
  const url = `${SERVICE}/route/analyze${tGrade ? `?t_grade=${tGrade}` : ""}`;
  const res = await fetchWithTimeout(
    url,
    { method: "POST", body, headers: { "Content-Type": "application/gpx+xml" } },
    SERVICE_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) throw badResponse("route analyze", res.status, text);
  const r = JSON.parse(text);
  if (typeof r.distance_km !== "number" || typeof r.climb_m !== "number" || typeof r.t_grade !== "number") {
    throw new Error(`route analyze returned an unexpected shape: ${text.slice(0, 200)}`);
  }
  return r as Route;
}

/** Ability 2 — get weather and sunset for the route's area on the hike date.
 *  Open-Meteo's sunset is location-local wall clock; we also capture the
 *  location's UTC offset so turn-back math compares true instants even when
 *  the hike is in another timezone than the laptop. */
export async function getWeather(lat: number | null, lon: number | null, date: string): Promise<Weather> {
  if (lat == null || lon == null) {
    return { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null, tempMaxC: null, error: "route has no coordinates" };
  }
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("daily", "sunset,precipitation_probability_max,temperature_2m_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("start_date", date);
  u.searchParams.set("end_date", date);
  let d: {
    utc_offset_seconds?: number;
    daily?: { sunset?: unknown[]; precipitation_probability_max?: unknown[]; temperature_2m_max?: unknown[] };
  };
  try {
    const res = await fetchWithTimeout(u, {}, WEATHER_TIMEOUT_MS);
    if (!res.ok) throw badResponse("open-meteo", res.status, await res.text());
    d = await res.json();
  } catch (e) {
    return { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null, tempMaxC: null, error: String(e) };
  }
  const daily = d.daily;
  const sunset = typeof daily?.sunset?.[0] === "string" ? (daily.sunset[0] as string) : null;
  if (!sunset) {
    return { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null, tempMaxC: null, error: "no sunset in forecast response" };
  }
  // "YYYY-MM-DDTHH:mm" location-local -> absolute instant via the location offset
  const offsetSec = typeof d.utc_offset_seconds === "number" ? d.utc_offset_seconds : 0;
  const sunsetEpochMs = Date.parse(`${sunset}:00Z`) - offsetSec * 1000;
  return {
    ok: Number.isFinite(sunsetEpochMs),
    sunset,
    sunsetEpochMs: Number.isFinite(sunsetEpochMs) ? sunsetEpochMs : null,
    rainChancePct: (daily?.precipitation_probability_max?.[0] ?? null) as number | null,
    tempMaxC: (daily?.temperature_2m_max?.[0] ?? null) as number | null,
  };
}

/** Ability 3 — call the TabPFN prediction service. */
export async function predictHike(f: Features) {
  const res = await fetchWithTimeout(
    `${SERVICE}/predict`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) },
    SERVICE_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) throw badResponse("predict", res.status, text);
  const r = JSON.parse(text);
  for (const k of ["p5_min", "expected_min", "p90_min", "p95_min"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) {
      throw new Error(`predict returned a bad ${k}: ${text.slice(0, 200)}`);
    }
  }
  return r as { p5_min: number; expected_min: number; p90_min: number; p95_min: number };
}

/** Ability 4 — the turn-back rule: when the cautious (P90) estimate says you'd
 *  still make it down, expressed against sunset. sunsetKnown=false means we
 *  could not get a trustworthy sunset — the caller must say so, never assume
 *  "fine". */
export function computeTurnBack(
  startIso: string,
  p90Min: number,
  weather: Pick<Weather, "sunset" | "sunsetEpochMs">,
) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new Error(`unparseable start time: ${startIso}`);
  const backBy = new Date(start.getTime() + p90Min * 60_000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const result: {
    backBy: string;
    sunset: string | null;
    sunsetKnown: boolean;
    marginMin: number | null;
    afterDark: boolean;
  } = { backBy: fmt(backBy), sunset: weather.sunset ?? null, sunsetKnown: false, marginMin: null, afterDark: false };
  if (weather.sunsetEpochMs != null) {
    result.sunsetKnown = true;
    result.marginMin = Math.round((weather.sunsetEpochMs - backBy.getTime()) / 60_000);
    result.afterDark = result.marginMin < 0;
  }
  return result;
}

/** Gemma 4 turns the numbers into a briefing that reads like a friend who hikes. */
export async function writeBriefing(facts: string): Promise<string> {
  const res = await fetchWithTimeout(
    `${GEMMA}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMMA_MODEL,
        messages: [
          { role: "system", content: "You are Turnaround, a hiking companion. Warm, practical, brief." },
          { role: "user", content: facts },
        ],
        stream: false,
        temperature: 0.7,
      }),
    },
    GEMMA_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) throw badResponse("gemma", res.status, text);
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`gemma returned no content: ${text.slice(0, 200)}`);
  }
  return content.trim();
}

/** Piper renders the briefing to a wav the hiker can play offline on the trail. */
export function speakBriefing(text: string, outWav: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, ["-m", PIPER_VOICE, "-f", outWav], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (e) => reject(new Error(`piper spawn failed (${PIPER_BIN}): ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(outWav);
      else reject(new Error(`piper failed (exit ${code}): ${(stderr || "(no stderr)").split("\n")[0]}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

export interface PlanResult {
  route: Route;
  prediction: { p5_min: number; expected_min: number; p90_min: number; p95_min: number };
  weather: Weather;
  turnBack: ReturnType<typeof computeTurnBack>;
  briefing?: string;
  briefingError?: string;
  wav?: string;
}

/** The whole flow: route -> prediction -> weather -> turn-back -> briefing.
 *  Route/prediction/turn-back failures throw (they ARE the product); weather
 *  and briefing/degradation never abort the plan. */
export async function planTrip(opts: {
  gpxPath: string;
  tGrade?: number;
  startIso: string;
  speakWav?: string;
}): Promise<PlanResult> {
  const route = await readRoute(opts.gpxPath, opts.tGrade);
  const date = opts.startIso.slice(0, 10);
  const features: Features = {
    distance_km: route.distance_km,
    climb_m: route.climb_m,
    descent_m: route.descent_m,
    highest_m: route.highest_m,
    t_grade: route.t_grade,
  };
  const prediction = await predictHike(features);
  // weather failing must not sink the plan — degrade to "sunset unknown"
  const weather = await getWeather(route.lat, route.lon, date).catch(
    (e: unknown): Weather => ({ ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null, tempMaxC: null, error: String(e) }),
  );
  const turnBack = computeTurnBack(opts.startIso, prediction.p90_min, weather);

  let briefing: string | undefined;
  let briefingError: string | undefined;
  let wav: string | undefined;
  try {
    const facts = [
      "Write a short spoken briefing for a hiker about to start this trip.",
      "Sound like a friend who hikes, not a robot. 4 to 6 short sentences.",
      "No lists, no markdown, no emoji. Weave in the turn-back time and the",
      "sunset situation naturally. Facts:",
      `Route: ${route.distance_km} km, ${route.climb_m} m of climbing, high point ${route.highest_m} m, grade T${route.t_grade}.`,
      `Started at ${opts.startIso}; expected moving time ${Math.round(prediction.expected_min)} min; turn back by ${turnBack.backBy}.`,
      weather.ok
        ? `Sunset ${weather.sunset} — that is ${turnBack.marginMin} minutes after the turn-back time. Rain chance ${weather.rainChancePct ?? "unknown"}%.`
        : "Sunset time unknown (no forecast available) — tell the hiker to plan to be back early rather than inventing a sunset.",
    ].join(" ");
    briefing = await writeBriefing(facts);
    if (opts.speakWav) wav = await speakBriefing(briefing, opts.speakWav);
  } catch (e) {
    briefingError = String(e);
  }
  return { route, prediction, weather, turnBack, briefing, briefingError, wav };
}
