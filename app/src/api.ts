// The one place that talks HTTP. Every path goes through the vite /api proxy
// to the prediction service, which is the app's single backend.

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
  start_lat: number | null;
  start_lon: number | null;
}

/** Minutes after the start for each moment of a trip (the service's timeline()),
 *  plus clock times once the trip has started. */
export interface Timeline {
  turn_around_after_min: number;
  expected_back_after_min: number;
  back_by_after_min: number;
  alert_after_min: number;
  turn_around_at?: string;
  expected_back_at?: string;
  back_by_at?: string;
  alert_at?: string;
}

export interface Trip extends Features, Timeline {
  id: number;
  name: string;
  p5_min: number; // moving-time quantiles, already scaled by your pace factor
  expected_min: number;
  p90_min: number;
  p95_min: number;
  crowd_min: number | null;
  pace_factor: number;
  breaks_min: number;
  hiker_name: string | null;
  contact_email: string | null;
  started_at: string | null;
  finished_at: string | null;
  actual_min: number | null;
  moving_min: number | null;
  status: string;
  timer_status: string; // not_started | armed | failed: <why>
  sunset_at: string | null;
  rain_pct: number | null;
  briefing: string | null;
  drill: boolean;
}

export interface CheckinResult extends Trip {
  checkin_signal: string; // delivered | no_timer | failed: <why>
  alert_fired: boolean;
  already_checked_out: boolean;
  trained: boolean;
  your_pace_factor: number;
  your_pace_hikes: number;
}

export interface Prediction {
  p5_min: number;
  expected_min: number;
  p90_min: number;
  p95_min: number;
  crowd_expected_min: number;
  pace_factor: number;
  pace_hikes: number;
}

export interface Sunset {
  ok: boolean;
  sunset: string | null;
  sunsetEpochMs: number | null;
  rainChancePct: number | null;
}

export interface TripCreate extends Features {
  name: string;
  contact_email: string;
  hiker_name: string | null;
  breaks_min: number;
  lat: number | null;
  lon: number | null;
  start_lat: number | null;
  start_lon: number | null;
  sunset_at: string | null;
  rain_pct: number | null;
  planned_start: string | null;
}

/** An HTTP error from the service. Network failures stay plain Errors — the
 *  difference decides whether a queued check-in is worth retrying. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE = "/api";

async function j<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

const post = (path: string, body?: unknown, signal?: AbortSignal) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

export const api = {
  analyzeRoute: (file: File, tGrade: number) =>
    fetch(`${BASE}/route/analyze?t_grade=${tGrade}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/gpx+xml" },
    }).then((r) => j<Route>(r)),

  predict: (f: Features, signal?: AbortSignal) => post("/predict", f, signal).then((r) => j<Prediction>(r)),

  createTrip: (payload: TripCreate) => post("/trips", payload).then((r) => j<Trip>(r)),

  getTrip: (id: number) => fetch(`${BASE}/trips/${id}`, { signal: AbortSignal.timeout(10_000) }).then((r) => j<Trip>(r)),

  /** drillSec: drills only — the contact is emailed this many seconds after the start. */
  startTrip: (id: number, drillSec?: number) =>
    post(`/trips/${id}/start${drillSec ? `?alert_in_sec=${drillSec}` : ""}`).then((r) => j<Trip>(r)),

  armTrip: (id: number) => post(`/trips/${id}/arm`).then((r) => j<Trip>(r)),

  checkout: (id: number, actualMin: number) =>
    fetch(`${BASE}/trips/${id}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actual_min: actualMin }),
      signal: AbortSignal.timeout(20_000),
    }).then((r) => j<CheckinResult>(r)),

  briefing: (id: number) => post(`/trips/${id}/briefing`).then((r) => j<{ briefing: string }>(r)),

  briefingAudio: async (id: number): Promise<Blob> => {
    const res = await post(`/trips/${id}/briefing/audio`);
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${(await res.text()).slice(0, 120)}`);
    return res.blob();
  },
};

/** Clock time `min` minutes after `startIso`, as epoch ms. */
export function after(startIso: string, min: number): number {
  return new Date(startIso).getTime() + min * 60_000;
}

/** Parse elevation samples out of a GPX file, in track order. Used for the
 *  elevation profile card and computed in the browser — the file never leaves
 *  the machine. */
export function gpxElevations(text: string): number[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  return Array.from(doc.getElementsByTagName("ele"))
    .map((e) => parseFloat(e.textContent ?? ""))
    .filter((n) => Number.isFinite(n));
}

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
