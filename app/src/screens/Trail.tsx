import { useEffect, useRef, useState } from "react";
import { after, api } from "../api";
import { prepareBriefing } from "../briefing";
import { fmtClock, fmtHM, fmtTimeOfDay } from "../format";
import { saved, type PendingCheckin } from "../store";
import type { PlanData } from "../App";
import type { Trip } from "../api";

const RING_C = 2 * Math.PI * 126; // circumference of the r=126 ring

const COLORS = {
  green: "#1F4D35",
  amber: "#B7791F",
  red: "#B54A3B",
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Trail({
  plan,
  pending,
  checkinError,
  onCheckIn,
  onRetryNow,
  onTripUpdate,
}: {
  plan: PlanData;
  pending: PendingCheckin | null;
  checkinError: string | null;
  onCheckIn: (actualMin: number) => void;
  onRetryNow: () => void;
  onTripUpdate: (t: Trip) => void;
}) {
  const { trip, prediction, sunset } = plan;
  const startIso = trip.started_at ?? new Date().toISOString();
  const startMs = Date.parse(startIso);
  const at = (iso: string | undefined, min: number) => (iso ? Date.parse(iso) : after(startIso, min));
  const turnAt = at(trip.turn_around_at, trip.turn_around_after_min);
  const backAt = at(trip.back_by_at, trip.back_by_after_min);
  const alertAt = at(trip.alert_at, trip.alert_after_min);
  const armed = trip.timer_status === "armed";

  const [now, setNow] = useState(Date.now());
  const [online, setOnline] = useState(navigator.onLine);
  const [briefing, setBriefing] = useState<string | null>(() => saved.briefing(trip.id) ?? trip.briefing);
  const [briefingErr, setBriefingErr] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<"preparing" | "ready" | "failed">("preparing");
  const [briefingTry, setBriefingTry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [audioSec, setAudioSec] = useState(0);
  const [audioDur, setAudioDur] = useState(0);
  const [arming, setArming] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  // the briefing was prepared on the Plan screen; this picks up the same
  // promise or the copy saved on the phone, and retries if neither exists
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setAudioState("preparing");
    prepareBriefing(trip.id)
      .then((b) => {
        if (!live) return;
        setBriefing(b.text);
        setBriefingErr(null);
        if (b.audio) {
          url = URL.createObjectURL(b.audio);
          setAudioUrl(url);
          setAudioState("ready");
        } else {
          setAudioState("failed");
        }
      })
      .catch((e) => {
        if (!live) return;
        setBriefingErr(msg(e));
        setAudioState("failed");
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [trip.id, briefingTry]);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play().catch(() => setPlaying(false));
  }

  async function retryArm() {
    setArming(true);
    setArmError(null);
    try {
      onTripUpdate(await api.armTrip(trip.id));
    } catch (e) {
      setArmError(msg(e));
    } finally {
      setArming(false);
    }
  }

  const elapsedSec = Math.max(0, (now - startMs) / 1000);

  // where the hike is: heading out → heading back → overdue → contact alerted
  let phase: { color: string; label: string; target: number; from: number; caption: string; pulse: boolean };
  if (now < turnAt) {
    const urgent = turnAt - now <= 15 * 60_000;
    phase = {
      color: urgent ? COLORS.amber : COLORS.green,
      label: urgent ? "Under 15 minutes to turn around" : "You're on track",
      target: turnAt,
      from: startMs,
      caption: "until turn-around time",
      pulse: urgent,
    };
  } else if (now < backAt) {
    phase = { color: COLORS.amber, label: "Past turn-around — head back", target: backAt, from: turnAt, caption: "until your back-by time", pulse: false };
  } else if (armed && now < alertAt) {
    phase = { color: COLORS.red, label: "Overdue — check in when you're out", target: alertAt, from: backAt, caption: "until your contact is alerted", pulse: true };
  } else if (armed) {
    phase = { color: COLORS.red, label: "Contact alerted — check in to send the all-clear", target: alertAt, from: alertAt, caption: "since the alert", pulse: true };
  } else {
    phase = { color: COLORS.red, label: "Overdue — no safety timer is running", target: backAt, from: backAt, caption: "past your back-by time", pulse: true };
  }
  const remainingSec = (phase.target - now) / 1000;
  const frac = phase.target > phase.from ? Math.max(0, Math.min(1, (phase.target - now) / (phase.target - phase.from))) : 1;
  const expectedTotal = prediction.expected_min + (trip.breaks_min ?? 0);
  const deltaMin = Math.round(elapsedSec / 60 - expectedTotal);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="trail-head">
        <div className="trail-title">
          <span className="serif">{trip.name}</span>
          <span className="grade-badge">T{trip.t_grade}</span>
          {trip.drill && <span className="drill-chip">DRILL</span>}
        </div>
        <span className={`net-chip ${online ? "" : "offline"}`}>
          <span className="dot" style={{ background: online ? "var(--ok)" : "var(--amber)" }} />
          {online ? "Online" : "Offline — your plan is saved on this phone"}
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
                stroke={phase.color}
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - frac)}
                style={{ transition: "stroke-dashoffset 1s linear, stroke .4s" }}
              />
            </svg>
            <div className="ring-center">
              <span className={`ring-status ${phase.pulse ? "pulsing" : ""}`} style={{ color: phase.color }}>
                ● {phase.label}
              </span>
              <span className="ring-count" style={{ color: phase.color }}>
                {fmtClock(remainingSec)}
              </span>
              <span className="ring-caption">{phase.caption}</span>
            </div>
          </div>

          <div className="turnback-line">
            <span className="eyebrow">TURN AROUND BY</span>
            <span className="serif">{fmtTimeOfDay(turnAt)}</span>
            <span className="turnback-sub">
              back by {fmtTimeOfDay(backAt)}
              {sunset.sunsetEpochMs != null && <> · sunset {fmtTimeOfDay(sunset.sunsetEpochMs)}</>}
            </span>
          </div>

          <div className="mini-stats">
            <div className="mini-stat">
              <div className="v">{fmtHM(elapsedSec / 60)}</div>
              <div className="k">out so far</div>
            </div>
            <div className="mini-stat">
              <div className="v">{fmtHM(expectedTotal)}</div>
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
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {audioState === "ready" ? "saved to this device" : audioState === "preparing" ? "preparing audio…" : "audio unavailable"}
              </span>
            </div>
            {briefing ? (
              <p className="briefing-text">{briefing}</p>
            ) : (
              <p className="briefing-text" style={{ color: "var(--muted)", fontSize: 16 }}>
                {briefingErr ? "Briefing unavailable right now — the plan above still stands." : "writing…"}
              </p>
            )}
            <div className="audio-pill">
              <button
                className="play"
                aria-label={playing ? "Pause briefing" : "Play briefing"}
                onClick={togglePlay}
                disabled={!audioUrl}
                style={!audioUrl ? { opacity: 0.5, cursor: "default" } : undefined}
              >
                {playing ? "❚❚" : "▶"}
              </button>
              <span className="time">
                {fmtClock(audioSec)} / {audioDur ? fmtClock(audioDur) : "--:--"}
              </span>
              <div className="track">
                <div style={{ width: audioDur ? `${(audioSec / audioDur) * 100}%` : "0%" }} />
              </div>
            </div>
            {audioState === "failed" && (
              <button className="linklike" style={{ alignSelf: "flex-start" }} onClick={() => setBriefingTry((n) => n + 1)}>
                Try the briefing again
              </button>
            )}
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

          {armed ? (
            <div className="timer-row">
              <span>Safety timer armed</span>
              <span>
                Alerts <strong>{trip.contact_email}</strong> if no check-in by {fmtTimeOfDay(alertAt)}
              </span>
            </div>
          ) : (
            <div className="timer-row unarmed" role="alert">
              <strong>Safety timer NOT armed</strong>
              <span>
                {trip.contact_email} will not be alerted if something goes wrong.
                {trip.timer_status.startsWith("failed") && <> ({trip.timer_status.replace(/^failed:\s*/, "")})</>}
              </span>
              {armError && <span>Retry failed: {armError}</span>}
              <button className="btn-secondary" onClick={retryArm} disabled={arming}>
                {arming ? "Arming…" : "Try arming it again"}
              </button>
            </div>
          )}

          {checkinError && <p className="error-box">{checkinError}</p>}

          {pending ? (
            <div className="pending-card" role="status">
              <strong>Check-in saved on this phone</strong>
              <span>
                {online
                  ? "Sending it to your laptop — retrying every few seconds until it lands."
                  : "You're offline. It sends the moment this phone can reach your laptop."}{" "}
                Keep this page open.
              </span>
              <button className="btn-secondary" onClick={onRetryNow}>
                Try now
              </button>
            </div>
          ) : (
            <button className="im-out" onClick={() => onCheckIn(Math.max(1, Math.round(elapsedSec / 60)))}>
              I'm out <span style={{ fontSize: "0.9em" }}>✓</span>
            </button>
          )}
          <p style={{ margin: 0, textAlign: "center", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            One tap stops the safety timer. No signal? It's saved on this phone and sent the moment
            it can reach your laptop.
          </p>
        </section>
      </div>
    </div>
  );
}
