import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Prediction, type Trip } from "../api";
import { fmtClock, fmtHM, fmtTimeOfDay } from "../format";
import type { PlanData } from "../App";

const RING_C = 2 * Math.PI * 126; // circumference of the r=126 ring

const COLORS = {
  green: "#1F4D35",
  amber: "#B7791F",
  red: "#B54A3B",
};

export default function Trail({
  plan,
  onOut,
}: {
  plan: PlanData;
  onOut: (t: Trip) => void;
}) {
  const { trip, prediction, route, sunset } = plan;
  const totalMs = trip.p90_min * 60_000;
  const backByMs = useMemo(
    () => new Date(trip.started_at ?? Date.now()).getTime() + totalMs,
    [trip.started_at, totalMs],
  );

  const [now, setNow] = useState(Date.now());
  const [online, setOnline] = useState(navigator.onLine);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [briefingErr, setBriefingErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [audioSec, setAudioSec] = useState(0);
  const [audioDur, setAudioDur] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cacheKey = `turnaround-trail-${trip.id}`;
  const elapsedSec = Math.max(0, (now - new Date(trip.started_at ?? now).getTime()) / 1000);
  const remainingSec = (backByMs - now) / 1000;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);

  // briefing: live from the service, cached copy when the trail has no signal
  useEffect(() => {
    const cached = localStorage.getItem(cacheKey);
    (async () => {
      try {
        const b = await api.briefing(trip.id);
        setBriefing(b.briefing);
        localStorage.setItem(cacheKey, JSON.stringify({ briefing: b.briefing }));
      } catch (e) {
        if (cached) {
          setBriefing(JSON.parse(cached).briefing ?? null);
          setBriefingErr(null);
        } else {
          setBriefingErr(String(e instanceof Error ? e.message : e));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id]);

  async function makeAudio() {
    setBusy("rendering…");
    setError(null);
    try {
      const res = await api.briefingAudio(trip.id);
      if (!res.ok) throw new Error(`${res.status} ${await res.text().then((t) => t.slice(0, 120))}`);
      const blob = await res.blob();
      setAudioUrl(URL.createObjectURL(blob));
    } catch (e) {
      // keep the button — the hiker can retry (e.g. text wasn't generated yet)
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play().catch(() => setPlaying(false));
  }

  async function imOut() {
    setBusy("checking in…");
    setError(null);
    try {
      const t = await api.checkout(trip.id, Math.max(1, Math.round(elapsedSec / 60)));
      onOut(t);
    } catch (e) {
      setBusy(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // ring state
  const overdue = remainingSec <= 0;
  const urgent = !overdue && remainingSec <= 15 * 60;
  const frac = Math.max(0, Math.min(1, remainingSec / (totalMs / 1000)));
  const heroColor = overdue ? COLORS.red : urgent ? COLORS.amber : COLORS.green;
  const statusLabel = overdue ? "Overdue — turn back now" : urgent ? "Under 15 minutes" : "You're on track";
  const countCaption = overdue ? "past turn-back time" : "until turn-back time";
  const deltaMin = Math.round(elapsedSec / 60 - prediction.expected_min);

  const audioMM = fmtClock(audioSec);
  const audioTotal = audioDur ? fmtClock(audioDur) : "--:--";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="trail-head">
        <div className="trail-title">
          <span className="serif">{route ? trip.name : trip.name}</span>
          <span className="grade-badge">T{trip.t_grade}</span>
        </div>
        <span className={`net-chip ${online ? "" : "offline"}`}>
          <span className="dot" style={{ background: online ? "var(--ok)" : "var(--amber)" }} />
          {online ? "Online" : "Offline — plan is cached"}
        </span>
      </div>

      <div className="two-col">
        <section className="ring-card">
          <div className="ring-wrap">
            <svg viewBox="0 0 280 280">
              <circle cx="140" cy="140" r="126" fill="none" stroke="var(--line)" strokeWidth="10" />
              <circle
                cx="140"
                cy="140"
                r="126"
                fill="none"
                stroke={heroColor}
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - frac)}
                style={{ transition: "stroke-dashoffset 1s linear, stroke .4s" }}
              />
            </svg>
            <div className="ring-center">
              <span className={`ring-status ${urgent || overdue ? "pulsing" : ""}`} style={{ color: heroColor }}>
                ● {statusLabel}
              </span>
              <span className="ring-count" style={{ color: heroColor }}>
                {fmtClock(remainingSec)}
              </span>
              <span className="ring-caption">{countCaption}</span>
            </div>
          </div>

          <div className="turnback-line">
            <span className="eyebrow">TURN BACK AT</span>
            <span className="serif">{fmtTimeOfDay(backByMs)}</span>
          </div>

          <div className="mini-stats">
            <div className="mini-stat">
              <div className="v">{fmtHM(elapsedSec / 60)}</div>
              <div className="k">out so far</div>
            </div>
            <div className="mini-stat">
              <div className="v">{fmtHM(prediction.expected_min)}</div>
              <div className="k">expected in total</div>
            </div>
            <div className="mini-stat">
              <div className="v" style={{ color: deltaMin > 0 ? "var(--amber)" : "var(--green)" }}>
                {deltaMin >= 0 ? "+" : "−"}
                {fmtHM(Math.abs(deltaMin))}
              </div>
              <div className="k">vs expected</div>
            </div>
          </div>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="briefing-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Today's briefing</span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>saved to this device</span>
            </div>
            {briefing ? (
              <p className="briefing-text">{briefing}</p>
            ) : (
              <p className="briefing-text" style={{ color: "var(--muted)", fontSize: 16 }}>
                {briefingErr ? "briefing unavailable right now — the plan above still stands." : "writing…"}
              </p>
            )}
            <div className="audio-pill">
              <button
                className="play"
                aria-label="Play briefing"
                onClick={togglePlay}
                disabled={!audioUrl}
                style={!audioUrl ? { opacity: 0.5, cursor: "default" } : undefined}
              >
                {playing ? "❚❚" : "▶"}
              </button>
              <span className="time">
                {audioMM} / {audioDur ? fmtClock(audioDur) : "--:--"}
              </span>
              <div className="track">
                <div style={{ width: audioDur ? `${(audioSec / audioDur) * 100}%` : "0%" }} />
              </div>
            </div>
            <audio
              ref={audioRef}
              src={audioUrl ?? undefined}
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(e) => setAudioSec(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setAudioDur(e.currentTarget.duration || 0)}
            />
          </div>

          <div className="timer-row">
            <span>Safety timer armed</span>
            <span>
              Alerts <strong>{trip.contact_email}</strong> if no check-in by {fmtTimeOfDay(backByMs)}
            </span>
          </div>

          {error && <p className="error" style={{ color: "var(--red)", background: "rgba(181,74,59,.08)", borderRadius: 10, padding: "10px 12px" }}>{error}</p>}

          <button className="im-out" onClick={imOut} disabled={!!busy}>
            {busy ?? (<>I'm out <span style={{ fontSize: "0.9em" }}>✓</span></>)}
          </button>
          <p style={{ margin: 0, textAlign: "center", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            Stops the safety timer and lets your contact know you finished. Works offline; it
            sends as soon as you have signal.
          </p>
        </section>
      </div>
    </div>
  );
}
