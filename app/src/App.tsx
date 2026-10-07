import { useCallback, useEffect, useRef, useState } from "react";
import Plan from "./screens/Plan";
import Trail from "./screens/Trail";
import Out from "./screens/Out";
import { api, HttpError, type CheckinResult, type Trip } from "./api";
import { saved, type PendingCheckin, type SavedPlan } from "./store";

type View = "plan" | "trail" | "out";

/** The plan the trail and summary screens run on. The GPX File only exists in
 *  the session that uploaded it — a restored trip has everything else. */
export interface PlanData extends SavedPlan {
  file?: File;
}

function viewFromHash(): View {
  if (location.hash === "#trail") return "trail";
  if (location.hash === "#out") return "out";
  return "plan";
}

const strip = ({ route, prediction, sunset, trip }: PlanData): SavedPlan => ({ route, prediction, sunset, trip });

const logo = (
  <svg width="30" height="22" viewBox="0 0 30 22" fill="none" aria-hidden="true">
    <path d="M1 21 L10 6 L15 13 L19 8 L29 21 Z" stroke="#1F4D35" strokeWidth="2" strokeLinejoin="round" />
    <path d="M10 6 L12.5 10" stroke="#1F4D35" strokeWidth="2" />
  </svg>
);

export default function App() {
  // a trip in progress always wins: a refreshed or discarded tab lands back on
  // the trail screen, ready to check in
  const [view, setView] = useState<View>(() => (saved.active() ? "trail" : viewFromHash()));
  const [plan, setPlan] = useState<PlanData | null>(() => saved.active() ?? saved.result()?.plan ?? null);
  const [result, setResult] = useState<CheckinResult | null>(() => (saved.active() ? null : saved.result()?.result ?? null));
  const [pending, setPending] = useState<PendingCheckin | null>(() => saved.pending());
  const [checkinError, setCheckinError] = useState<string | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const flushing = useRef(false);

  const go = useCallback((v: View) => {
    if (location.hash !== `#${v}`) location.hash = v;
    setView(v);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateTrip = useCallback((t: Trip) => {
    setPlan((p) => {
      if (!p || p.trip.id !== t.id) return p;
      const next = { ...p, trip: t };
      saved.setActive(strip(next));
      return next;
    });
  }, []);

  // a restored trip: refresh it from the service when there's signal; without
  // signal the saved copy is the plan
  useEffect(() => {
    const a = saved.active();
    if (!a) return;
    api
      .getTrip(a.trip.id)
      .then((t) => {
        if (t.status === "active") updateTrip(t);
        else if (!saved.pending()) {
          // finished from another device, or this trip no longer exists here
          saved.setActive(null);
          setPlan(null);
          go("plan");
        }
      })
      .catch((e) => {
        if (e instanceof HttpError && e.status === 404 && !saved.pending()) {
          saved.setActive(null);
          setPlan(null);
          go("plan");
        }
      });
  }, [go, updateTrip]);

  const finish = useCallback(
    (res: CheckinResult) => {
      const p = planRef.current;
      if (p) saved.setResult({ plan: { ...strip(p), trip: res }, result: res });
      saved.setActive(null);
      setResult(res);
      go("out");
    },
    [go],
  );

  /** Send a check-in tapped earlier. Network trouble (no signal, laptop out of
   *  reach, service restarting) keeps it queued; only a refusal from the
   *  service drops it. Repeats are safe — the service's checkout is idempotent. */
  const flush = useCallback(async () => {
    const p = saved.pending();
    if (!p || flushing.current) return;
    flushing.current = true;
    try {
      const res = await api.checkout(p.tripId, p.actualMin);
      saved.setPending(null);
      setPending(null);
      setCheckinError(null);
      finish(res);
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        saved.setPending(null);
        setPending(null);
        setCheckinError(`The service refused the check-in: ${e.message}`);
      }
    } finally {
      flushing.current = false;
    }
  }, [finish]);

  useEffect(() => {
    if (!pending) return;
    void flush();
    const t = setInterval(() => void flush(), 15_000);
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", onOnline);
    };
  }, [pending, flush]);

  const checkIn = (actualMin: number) => {
    if (!plan) return;
    const p = { tripId: plan.trip.id, actualMin, tappedAt: Date.now() };
    saved.setPending(p);
    setPending(p);
    setCheckinError(null);
  };

  const steps: Array<{ id: View; num: string; label: string; enabled: boolean }> = [
    { id: "plan", num: "01", label: "Plan", enabled: true },
    { id: "trail", num: "02", label: "On trail", enabled: !!plan && !result },
    { id: "out", num: "03", label: "Summary", enabled: !!result },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand">
            {logo}
            <span className="brand-name">Turnaround</span>
            <a className="brand-pill" href="https://github.com/CodeNeuron58/Turnaround" target="_blank" rel="noreferrer">
              open source
            </a>
          </div>
          <nav className="steps">
            {steps.map((s) => (
              <button
                key={s.id}
                className={`step ${view === s.id ? "active" : plan || result ? "done" : ""}`}
                disabled={!s.enabled}
                onClick={() => go(s.id)}
              >
                <span className="num">{s.num}</span>
                {s.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="main">
        {view === "plan" && (
          <Plan
            onPlanned={(d) => {
              saved.setActive(strip(d));
              saved.setResult(null);
              setResult(null);
              setPlan(d);
              go("trail");
            }}
          />
        )}

        {view === "trail" &&
          (plan && !result ? (
            <Trail
              plan={plan}
              pending={pending?.tripId === plan.trip.id ? pending : null}
              checkinError={checkinError}
              onCheckIn={checkIn}
              onRetryNow={() => void flush()}
              onTripUpdate={updateTrip}
            />
          ) : (
            <EmptyCard onGo={() => go("plan")} />
          ))}

        {view === "out" &&
          (plan && result ? (
            <Out
              plan={plan}
              result={result}
              onAgain={() => {
                saved.setResult(null);
                setResult(null);
                setPlan(null);
                go("plan");
              }}
            />
          ) : (
            <EmptyCard onGo={() => go("plan")} />
          ))}
      </main>

      <footer className="footbar">
        <div className="footbar-in">
          <span>Turnaround is a planning aid. Your judgment on the mountain comes first.</span>
          <a href="https://github.com/CodeNeuron58/Turnaround" target="_blank" rel="noreferrer">
            View source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

function EmptyCard({ onGo }: { onGo: () => void }) {
  return (
    <section className="card" style={{ maxWidth: 640, margin: "0 auto", padding: 32, textAlign: "center" }}>
      <p>No trip in progress — plan a hike first.</p>
      <button className="btn-primary" style={{ maxWidth: 320 }} onClick={onGo}>
        Plan a hike
      </button>
    </section>
  );
}
