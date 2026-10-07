import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Prediction, type Trip } from "../api";

/** The on-trail screen: countdown to the turn-back time, the spoken briefing,
 *  and the big "I'm out" button. Everything important is cached in
 *  localStorage the moment it loads, so no signal on the trail is survivable. */
export default function Trail({
  trip,
  prediction,
  onOut,
}: {
  trip: Trip;
  prediction: Prediction;
  onOut: (t: Trip) => void;
}) {
  const backByMs = useMemo(
    () => new Date(trip.started_at ?? Date.now()).getTime() + trip.p90_min * 60_000,
    [trip],
  );
  const [now, setNow] = useState(Date.now());
  const [briefing, setBriefing] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cacheKey = `turnaround-trail-${trip.id}`;
  const elapsedMin = Math.max(0, Math.round((Date.now() - new Date(trip.started_at ?? Date.now()).getTime()) / 60_000));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // try live, fall back to the cache (trail = no signal)
  useEffect(() => {
    const cached = localStorage.getItem(cacheKey);
    (async () => {
      try {
        const b = await api.briefing(trip.id);
        setBriefing(b.briefing);
        localStorage.setItem(cacheKey, JSON.stringify({ briefing: b.briefing, backByMs }));
      } catch {
        if (cached) {
          setOffline(true);
          setBriefing(JSON.parse(cached).briefing ?? null);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id]);

  async function makeAudio() {
    setBusy("rendering the audio…");
    setError(null);
    try {
      const res = await api.briefingAudio(trip.id);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      audioRef.current?.load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function imOut() {
    setBusy("checking in…");
    setError(null);
    try {
      const t = await api.checkout(trip.id, elapsedMin || 1);
      onOut(t);
    } catch (e) {
      setBusy(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  const remaining = backByMs - now;
  const overdue = remaining < 0;
  const mm = Math.floor(Math.abs(remaining) / 60_000);
  const ss = Math.floor((Math.abs(remaining) % 60_000) / 1000);
  const urgent = !overdue && remaining < 15 * 60_000;

  return (
    <section className="card trail">
      <h2>{trip.name}</h2>
      {offline && <p className="note">offline — showing your cached plan</p>}

      <div className={`countdown ${overdue ? "overdue" : urgent ? "urgent" : ""}`}>
        <span className="k">{overdue ? "overdue — turn back now" : "turn back in"}</span>
        <span className="v big">{overdue ? `-${mm}:${pad(ss)}` : `${mm}:${pad(ss)}`}</span>
        <span className="k">hard turn-back at {new Date(backByMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>

      <div className="stat">
        <span className="k">out for</span>
        <span className="v">{elapsedMin} min · expected {Math.round(prediction.expected_min)} min</span>
      </div>

      <div className="briefing">
        <h3>Your briefing</h3>
        {briefing ? <p>{briefing}</p> : <p className="note">{busy ?? "loading…"}</p>}
        {!audioUrl && briefing && (
          <button onClick={makeAudio} disabled={!!busy}>{busy ?? "🔊 Make the spoken briefing"}</button>
        )}
        {audioUrl && <audio ref={audioRef} controls src={audioUrl} />}
      </div>

      {error && <p className="error">{error}</p>}
      <button className="primary go" onClick={imOut} disabled={!!busy}>I'm out ✓</button>
    </section>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
