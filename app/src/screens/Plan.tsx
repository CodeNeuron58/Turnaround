import { useState } from "react";
import { api, fetchSunset, type Prediction, type Sunset, type Trip } from "../api";

const fmt = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export default function Plan({ onStarted }: { onStarted: (trip: Trip, p: Prediction) => void }) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState(3);
  const [start, setStart] = useState(() => {
    const n = new Date(Date.now() + 30 * 60_000);
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
  });
  const [contact, setContact] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [route, setRoute] = useState<(Awaited<ReturnType<typeof api.analyzeRoute>>) | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [sunset, setSunset] = useState<Sunset | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function planHike() {
    setError(null);
    if (!file || !name.trim() || !contact.trim()) {
      setError("a GPX file, a route name and a contact email are all required");
      return;
    }
    try {
      setBusy("reading your route…");
      const route = await api.analyzeRoute(file, grade);
      setRoute(route);

      setBusy("predicting your time (TabPFN)…");
      const features = {
        distance_km: route.distance_km,
        climb_m: route.climb_m,
        descent_m: route.descent_m,
        highest_m: route.highest_m,
        t_grade: route.t_grade,
      };
      const p = await api.predict(features);
      setPrediction(p);

      setBusy("checking the sky…");
      setSunset(await fetchSunset(route.lat, route.lon, start.slice(0, 10)));

      setBusy("saving the trip…");
      const t = await api.createTrip({ ...features, name: name.trim(), contact_email: contact.trim() });
      setTrip(t);
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function startHike() {
    if (!trip || !prediction) return;
    setError(null);
    try {
      setBusy("arming the safety timer…");
      const t = await api.startTrip(trip.id);
      if (t.safety_timer && t.safety_timer !== "started") {
        setError(`trip started, but the safety timer failed: ${t.safety_timer}`);
        setBusy(null);
        return;
      }
      onStarted(t, prediction);
    } catch (e) {
      setBusy(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  const backBy =
    trip && trip.p90_min
      ? fmt(new Date(new Date(start).getTime() + trip.p90_min * 60_000))
      : null;
  const margin =
    trip && sunset?.sunsetEpochMs
      ? Math.round((sunset.sunsetEpochMs - (new Date(start).getTime() + trip.p90_min * 60_000)) / 60_000)
      : null;

  return (
    <section className="card">
      <h2>Plan your hike</h2>

      <label>Route name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shivapika loop" maxLength={120} />
      </label>

      <label>GPX file
        <input type="file" accept=".gpx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <div className="row">
        <label>Grade (T1–T6)
          <select value={grade} onChange={(e) => setGrade(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((g) => <option key={g} value={g}>T{g}</option>)}
          </select>
        </label>
        <label>Start time
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
      </div>

      <label>Emergency contact (email)
        <input type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="friend@example.com" />
      </label>

      <button className="primary" onClick={planHike} disabled={!!busy || !file || !name || !contact}>
        {busy ?? "Plan this hike"}
      </button>

      {error && <p className="error">{error}</p>}

      {route && prediction && trip && (
        <div className="results">
          <div className="stat">
            <span className="k">route</span>
            <span className="v">{route.distance_km} km · {route.climb_m} m up · T{route.t_grade}</span>
          </div>
          <div className="stat">
            <span className="k">likely time</span>
            <span className="v">{Math.round(prediction.expected_min)} min <small>(range {Math.round(prediction.p5_min)}–{Math.round(prediction.p95_min)})</small></span>
          </div>
          <div className="stat">
            <span className="k">turn back by</span>
            <span className="v big">{backBy}</span>
          </div>
          <div className="stat">
            <span className="k">sunset</span>
            <span className="v">
              {sunset?.ok
                ? `${sunset.sunset?.slice(11)} · ${marginMin(margin)} of margin${sunset.rainChancePct != null ? ` · ${sunset.rainChancePct}% rain` : ""}`
                : "unknown — plan to be back early"}
            </span>
          </div>
          <p className="note">the cautious estimate (9 in 10 hikes finish sooner) sets your alarm</p>
          <button className="primary go" onClick={startHike}>Start hike — arm the safety timer</button>
        </div>
      )}
    </section>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
function marginMin(m: number | null): string {
  if (m == null) return "unknown";
  if (m < 0) return `OVERDUE by ${-m} min`;
  return `${m} min`;
}
