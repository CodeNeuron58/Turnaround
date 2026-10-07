import { useEffect, useState } from "react";
import Plan from "./screens/Plan";
import Trail from "./screens/Trail";
import Out from "./screens/Out";
import type { Prediction, Sunset, Trip } from "./api";
import type { Features } from "./api";

type View = "plan" | "trail" | "out";

export interface RouteInfo extends Features {
  lat: number | null;
  lon: number | null;
}

export interface PlanData {
  route: RouteInfo;
  prediction: Prediction;
  sunset: Sunset;
  startIso: string;
  file: File;
  trip: Trip;
}

function viewFromHash(): View {
  if (location.hash === "#trail") return "trail";
  if (location.hash === "#out") return "out";
  return "plan";
}

const logo = (
  <svg width="30" height="22" viewBox="0 0 30 22" fill="none" aria-hidden="true">
    <path d="M1 21 L10 6 L15 13 L19 8 L29 21 Z" stroke="#1F4D35" strokeWidth="2" strokeLinejoin="round" />
    <path d="M10 6 L12.5 10" stroke="#1F4D35" strokeWidth="2" />
  </svg>
);

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [result, setResult] = useState<Trip | null>(null);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (v: View) => {
    location.hash = v;
    setView(v);
    window.scrollTo(0, 0);
  };

  const steps: Array<{ id: View; num: string; label: string; enabled: boolean }> = [
    { id: "plan", num: "01", label: "Plan", enabled: true },
    { id: "trail", num: "02", label: "On trail", enabled: !!plan },
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
              setPlan(d);
              go("trail");
            }}
          />
        )}

        {view === "trail" &&
          (plan ? (
            <Trail
              plan={plan}
              onOut={(t) => {
                setResult(t);
                go("out");
              }}
            />
          ) : (
            <EmptyCard onGo={() => go("plan")} />
          ))}

        {view === "out" &&
          (plan && result ? (
            <Out plan={plan} trip={result} onAgain={() => go("plan")} />
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
