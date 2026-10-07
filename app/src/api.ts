// The one place that talks HTTP. Every path goes through the vite /api proxy
// to the prediction service, which is the app's single backend.

export interface Features {
  distance_km: number;
  climb_m: number;
  descent_m: number;
  highest_m: number;
  t_grade: number;
}

export interface Trip {
  id: number;
  name: string;
  distance_km: number;
  climb_m: number;
  descent_m: number;
  highest_m: number;
  t_grade: number;
  p5_min: number;
  expected_min: number;
  p90_min: number;
  p95_min: number;
  started_at: string | null;
  finished_at: string | null;
  actual_min: number | null;
  status: string;
  contact_email: string | null;
  safety_timer?: string;
}

export interface Prediction {
  p5_min: number;
  expected_min: number;
  p90_min: number;
  p95_min: number;
}

export interface Sunset {
  ok: boolean;
  sunset: string | null;
  sunsetEpochMs: number | null;
  rainChancePct: number | null;
}

const BASE = "/api";

async function j<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export const api = {
  analyzeRoute: (file: File, tGrade: number) =>
    fetch(`/api/route/analyze?t_grade=${tGrade}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/gpx+xml" },
    }).then((r) => j<Features & { lat: number | null; lon: number | null }>(r)),

  predict: (f: Features) =>
    fetch(`${BASE}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    }).then((r) => j<Prediction>(r)),

  createTrip: (payload: Features & { name: string; contact_email: string }) =>
    fetch(`${BASE}/trips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => j<Trip>(r)),

  startTrip: (id: number) =>
    fetch(`${BASE}/trips/${id}/start`, { method: "POST" }).then((r) => j<Trip>(r)),

  checkout: (id: number, actualMin: number) =>
    fetch(`${BASE}/trips/${id}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actual_min: actualMin }),
    }).then((r) => j<Trip>(r)),

  briefing: (id: number) =>
    fetch(`${BASE}/trips/${id}/briefing`, { method: "POST" }).then((r) => j<{ briefing: string }>(r)),

  briefingAudio: (id: number) => fetch(`${BASE}/trips/${id}/briefing/audio`, { method: "POST" }),
};

/** Open-Meteo is called straight from the browser (it allows CORS).
 *  Sunset is location-local wall clock; we correct it to a true instant. */
export async function fetchSunset(lat: number | null, lon: number | null, date: string): Promise<Sunset> {
  if (lat == null || lon == null) return { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null };
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("daily", "sunset,precipitation_probability_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("start_date", date);
  u.searchParams.set("end_date", date);
  try {
    const d = await fetch(u, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    const sunset = typeof d.daily?.sunset?.[0] === "string" ? (d.daily.sunset[0] as string) : null;
    if (!sunset) return { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null };
    const offsetSec = typeof d.utc_offset_seconds === "number" ? d.utc_offset_seconds : 0;
    const sunsetEpochMs = Date.parse(`${sunset}:00Z`) - offsetSec * 1000;
    return {
      ok: Number.isFinite(sunsetEpochMs),
      sunset,
      sunsetEpochMs: Number.isFinite(sunsetEpochMs) ? sunsetEpochMs : null,
      rainChancePct: (d.daily?.precipitation_probability_max?.[0] ?? null) as number | null,
    };
  } catch {
    return { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null };
  }
}
