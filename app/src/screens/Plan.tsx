import { useEffect, useRef, useState } from "react";
import { after, api, fetchSunset, gpxElevations, type Features, type Prediction, type Route, type Sunset, type Trip } from "../api";
import { prepareBriefing } from "../briefing";
import { fmtHM, fmtMargin, fmtNum, fmtTimeOfDay, startLabel } from "../format";
import { saved } from "../store";
import type { PlanData } from "../App";

const GRADE_HINTS: Record<number, string> = {
  1: "T1 · flat valley walking",
  2: "T2 · some uphill, still easy",
  3: "T3 · steady mountain hiking",
  4: "T4 · hands now and then, real exposure",
  5: "T5 · scramble territory",
  6: "T6 · alpine — rope and experience",
};

type Phase = "form" | "loading" | "ready";

const pad = (n: number) => String(n).padStart(2, "0");
const NO_SUNSET: Sunset = { ok: false, sunset: null, sunsetEpochMs: null, rainChancePct: null };

/** ?drill=120 — the missed-check-in drill: the contact is emailed 120 s after
 *  Start instead of hours later. Shown loudly on every screen while active. */
function drillSeconds(): number | undefined {
  const n = Number(new URLSearchParams(location.search).get("drill"));
  return Number.isFinite(n) && n >= 30 ? Math.round(n) : undefined;
}

const features = (r: Route, grade: number): Features => ({
  distance_km: r.distance_km,
  climb_m: r.climb_m,
  descent_m: r.descent_m,
  highest_m: r.highest_m,
  t_grade: grade,
});

export default function Plan({ onPlanned }: { onPlanned: (d: PlanData) => void }) {
  const [phase, setPhase] = useState<Phase>("form");
  const [name, setName] = useState("");
  const [grade, setGrade] = useState(3);
  const [start, setStart] = useState(() => {
    const n = new Date(Date.now() + 30 * 60_000);
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
  });
  const [breaks, setBreaks] = useState(30);
  const [hiker, setHiker] = useState(() => saved.hikerName());
  const [contact, setContact] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [sunset, setSunset] = useState<Sunset | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [elevs, setElevs] = useState<number[] | null>(null);
  const [stage, setStage] = useState("");
  const [loadPct, setLoadPct] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drillSec = drillSeconds();

  // elevation profile comes straight from the GPX, parsed in the browser
  useEffect(() => {
    if (phase === "ready" && file) {
      file
        .text()
        .then((t) => setElevs(gpxElevations(t)))
        .catch(() => setElevs(null));
    }
  }, [phase, file]);

  function pickFile(f: File | null) {
    setFile(f);
    setElevs(null);
  }

  async function planHike() {
    setError(null);
    setPhase("loading");
    setLoadPct(6);
    setStage("Reading your GPX — distance, climbing, high point…");
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = Date.now();
    const estimate = 30_000;
    const prog = setInterval(() => {
      setLoadPct(Math.min(92, Math.round(((Date.now() - t0) / estimate) * 100)));
      const s = (Date.now() - t0) / 1000;
      setStage(s < 8 ? "Reading your GPX — distance, climbing, high point…" : "Asking TabPFN for your time, and the sky for your sunset…");
    }, 500);
    try {
      const route = await api.analyzeRoute(file!, grade);
      setLoadPct(38);
      setStage("Asking TabPFN for your time, and the sky for your sunset…");
      const prediction = await api.predict(features(route, grade), ac.signal);
      setLoadPct(84);
      setStage("Checking the sky…");
      const sun = await fetchSunset(route.lat, route.lon, start.slice(0, 10));
      setLoadPct(100);
      setStage("Saving the trip…");
      const t = await api.createTrip({
        ...features(route, grade),
        name: name.trim(),
        contact_email: contact.trim(),
        hiker_name: hiker.trim() || null,
        breaks_min: breaks,
        lat: route.lat,
        lon: route.lon,
        start_lat: route.start_lat,
        start_lon: route.start_lon,
        sunset_at: sun.sunsetEpochMs != null ? new Date(sun.sunsetEpochMs).toISOString() : null,
        rain_pct: sun.rainChancePct,
        planned_start: new Date(start).toISOString(),
      });
      saved.setHikerName(hiker.trim());
      // write and voice the briefing now, while there's signal — it's on the
      // phone before the trailhead
      prepareBriefing(t.id).catch(() => {});
      setRoute(route);
      setPrediction(prediction);
      setSunset(sun);
      setTrip(t);
      setTimeout(() => setPhase("ready"), 400);
    } catch (e) {
      setPhase("form");
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(String(e instanceof Error ? e.message : e));
      }
    } finally {
      clearInterval(prog);
      abortRef.current = null;
    }
  }

  function cancelPredict() {
    abortRef.current?.abort();
  }

  async function startHike() {
    if (!trip || !route || !prediction) return;
    setStarting(true);
    setError(null);
    try {
      const t = await api.startTrip(trip.id, drillSec);
      onPlanned({ route, prediction, sunset: sunset ?? NO_SUNSET, trip: t, file: file ?? undefined });
    } catch (e) {
      setStarting(false);
      setError(`Couldn't start the trip: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (phase === "loading") {
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
        <div className="eyebrow">BEFORE YOU LEAVE</div>
        <h1 className="h1">Plan your hike</h1>
        <div className="card" style={{ padding: "clamp(20px,4vw,32px)", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="loading-row">
            <div className="spinner" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="loading-title">Predicting your time…</div>
              <div className="loading-stage">{stage}</div>
            </div>
            <span className="mono" style={{ fontSize: 14, color: "var(--muted)" }}>~{Math.max(1, Math.round((100 - loadPct) / 5))}s</span>
          </div>
          <div className="load-track">
            <div className="load-fill" style={{ width: `${loadPct}%` }} />
          </div>
          <button className="linklike" style={{ alignSelf: "center" }} onClick={cancelPredict}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase === "ready" && trip && prediction && route) {
    // times assume the planned start; the trail screen recounts them from the
    // moment Start is pressed
    const startIso = new Date(start).toISOString();
    const turnAt = after(startIso, trip.turn_around_after_min);
    const backAt = after(startIso, trip.back_by_after_min);
    const alertAt = after(startIso, trip.alert_after_min);
    const marginMin = sunset?.sunsetEpochMs != null ? Math.round((sunset.sunsetEpochMs - backAt) / 60_000) : null;
    const lo = prediction.p5_min * 0.92;
    const hi = prediction.p95_min * 1.05;
    const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
    const profile = elevPath(elevs);
    const tuned = prediction.pace_hikes > 0;
    const pacePct = Math.round(Math.abs(prediction.pace_factor - 1) * 100);
    const chip =
      marginMin == null
        ? { cls: "neutral", text: "Sunset unknown" }
        : marginMin < 0
          ? { cls: "warn", text: "Back after dark" }
          : { cls: "", text: "Good to go" };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="ready-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="linklike" onClick={() => setPhase("form")}>← Edit plan</button>
            <div className="ready-title">
              <h1 className="h1 mid">{name}</h1>
              <span className="grade-badge">T{grade}</span>
              {drillSec && <span className="drill-chip">DRILL · alert {drillSec}s after start</span>}
            </div>
            <span style={{ fontSize: 15, color: "var(--muted)" }}>{startLabel(start)} start</span>
          </div>
          <span className={`good-chip ${chip.cls}`}><span className="dot" />{chip.text}</span>
        </div>

        <div className="two-col">
          <section className="hero-green">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="eyebrow">TURN AROUND BY</span>
              <span className="turnback-serif">{fmtTimeOfDay(turnAt)}</span>
              <span className="hero-sub">
                Not at the top — or the far end — by then? Head back. That gets you down by{" "}
                {fmtTimeOfDay(backAt)}, the cautious estimate: 9 in 10 hikes like this
                {tuned ? " at your pace" : ""} finish sooner
                {trip.breaks_min ? `, ${fmtHM(trip.breaks_min)} of breaks included` : ""}.
                {marginMin != null && marginMin < 0 && " That's after sunset — start earlier or pick a shorter route."}
              </span>
            </div>
            <div className="hero-stats">
              <div>
                <div className="k">Back by</div>
                <div className="v">{fmtTimeOfDay(backAt)}</div>
              </div>
              <div>
                <div className="k">Sunset</div>
                <div className="v">{sunset?.sunsetEpochMs != null ? fmtTimeOfDay(sunset.sunsetEpochMs) : "—"}</div>
              </div>
              <div>
                <div className="k">Margin</div>
                <div className="v">{fmtMargin(marginMin)}</div>
              </div>
              <div>
                <div className="k">Rain</div>
                <div className="v">{sunset?.rainChancePct != null ? `${sunset.rainChancePct}%` : "—"}</div>
              </div>
            </div>
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="likely-card">
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Likely moving time</span>
              <span className="likely-time">{fmtHM(prediction.expected_min)}</span>
              <div className="range-viz">
                <div className="range-track" />
                <div className="range-band" style={{ left: `${pct(prediction.p5_min)}%`, width: `${pct(prediction.p95_min) - pct(prediction.p5_min)}%` }} />
                <div className="range-marker" style={{ left: `${pct(prediction.expected_min)}%` }} />
              </div>
              <div className="range-ends">
                <span>fast {fmtHM(prediction.p5_min)}</span>
                <span>slow {fmtHM(prediction.p95_min)}</span>
              </div>
              <span className="pace-line">
                {tuned
                  ? `Tuned to you: ${pacePct === 0 ? "the crowd's pace" : `${pacePct}% ${prediction.pace_factor > 1 ? "slower" : "faster"} than the crowd`}, from ${prediction.pace_hikes} hike${prediction.pace_hikes === 1 ? "" : "s"} of yours.`
                  : "The crowd's estimate. After your first check-in it tunes to your pace."}
              </span>
            </div>

            <div className="elev-card">
              <div className="elev-label">Elevation</div>
              <svg viewBox="0 0 400 90" preserveAspectRatio="none">
                {profile && (
                  <>
                    <path d={profile.area} fill="var(--green-soft)" />
                    <path d={profile.line} fill="none" stroke="var(--green)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  </>
                )}
              </svg>
              <div className="elev-stats">
                <div>
                  <div className="k">Distance</div>
                  <div className="v">{route.distance_km} km</div>
                </div>
                <div>
                  <div className="k">Climb</div>
                  <div className="v">{fmtNum(route.climb_m)} m</div>
                </div>
                <div>
                  <div className="k">High point</div>
                  <div className="v">{fmtNum(route.highest_m)} m</div>
                </div>
              </div>
            </div>
          </section>
        </div>

        {error && <p className="error-box">{error}</p>}

        <div className="sticky-cta">
          <span className="note-text">
            Starting arms the safety timer, and every time counts from that moment.{" "}
            {drillSec ? (
              <>
                <strong style={{ color: "var(--amber-text)" }}>Drill:</strong> we email{" "}
                <strong style={{ color: "var(--ink)" }}>{contact}</strong> {drillSec} seconds after you press Start
                unless you check in.
              </>
            ) : (
              <>
                If you haven't checked in by <strong style={{ color: "var(--ink)" }}>{fmtTimeOfDay(alertAt)}</strong>,
                we email <strong style={{ color: "var(--ink)" }}>{contact}</strong> your route and where you set off.
              </>
            )}
          </span>
          <button className="btn-primary" onClick={startHike} disabled={starting}>
            {starting ? "Arming the safety timer…" : <>Start hike <span>→</span></>}
          </button>
        </div>
      </div>
    );
  }

  // ---------- form ----------
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="eyebrow">BEFORE YOU LEAVE</span>
        <h1 className="h1">Plan your hike</h1>
        <p className="sub">Get a clear plan, a predicted time, and a safe turn-around point.</p>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "clamp(20px,4vw,32px)", display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <span className="section-label">1 · ROUTE</span>
            <label className="field">
              <span>Route name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ridge Trail" maxLength={120} />
            </label>

            <div className="field">
              <span>GPX file</span>
              {file ? (
                <div className="filechip">
                  <div className="gpx-badge">GPX</div>
                  <div className="meta">
                    <span className="fname">{file.name}</span>
                    {elevs && elevs.length > 1 && (
                      <span className="fstats">{elevs.length} trackpoints parsed</span>
                    )}
                  </div>
                  <button className="clear" aria-label="Remove file" onClick={() => pickFile(null)}>×</button>
                </div>
              ) : (
                <button className="dropzone" onClick={() => fileInputRef.current?.click()}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>
                    Drop a .gpx file, or <span style={{ color: "var(--green)", textDecoration: "underline" }}>browse</span>
                  </span>
                  <span style={{ fontSize: 13, color: "var(--muted)" }}>Export it from Komoot, Strava, Gaia, or any GPS app</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".gpx"
                style={{ display: "none" }}
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <div className="field">
              <span>Grade</span>
              <div className="grade-grid">
                {[1, 2, 3, 4, 5, 6].map((g) => (
                  <button key={g} className={`grade-pill ${grade === g ? "selected" : ""}`} title={GRADE_HINTS[g]} onClick={() => setGrade(g)}>
                    T{g}
                  </button>
                ))}
              </div>
              <span className="grade-hint">{GRADE_HINTS[grade]}</span>
            </div>
          </div>

          <div className="divider" />

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <span className="section-label">2 · WHEN, AND WHO TO TELL</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 16 }}>
              <label className="field">
                <span>Start time</span>
                <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="field">
                <span>Planned breaks (min)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={480}
                  step={5}
                  value={breaks}
                  onChange={(e) => setBreaks(Math.max(0, Math.min(480, Number(e.target.value) || 0)))}
                />
              </label>
              <label className="field">
                <span>Your name</span>
                <input className="input" value={hiker} onChange={(e) => setHiker(e.target.value)} placeholder="so they know who it's about" maxLength={60} />
              </label>
              <label className="field">
                <span>Emergency contact email</span>
                <input className="input" type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="someone@you.trust" />
              </label>
            </div>
            <span style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              The model predicts time in motion; your breaks are added on top. Your contact only hears
              from us if you don't check in after the hike.
            </span>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--line)", background: "var(--card-2)", padding: "clamp(18px,3vw,24px) clamp(20px,4vw,32px)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button className="btn-primary" disabled={!file || !name.trim() || !contact.trim()} onClick={planHike}>
              Predict my time <span>→</span>
            </button>
            <span style={{ fontSize: 13, color: "var(--muted)", textAlign: "center" }}>
              runs on this machine — the GPX never leaves it
            </span>
          </div>
        </div>
      </div>

      {error && <p className="error-box">{error}</p>}
    </div>
  );
}

/** Elevation profile SVG path from GPX samples (normalized to a 400×90 box). */
function elevPath(elevs: number[] | null): { line: string; area: string } | null {
  if (!elevs || elevs.length < 2) return null;
  const n = Math.min(elevs.length, 120);
  const step = Math.max(1, Math.floor(elevs.length / n));
  const pts: number[] = [];
  for (let i = 0; i < elevs.length; i += step) pts.push(elevs[i]);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * 400, 84 - ((v - min) / span) * 72]);
  const line = xy.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return { line, area: `${line} L400 90 L0 90 Z` };
}
