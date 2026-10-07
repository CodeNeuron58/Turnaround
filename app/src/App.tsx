import { useEffect, useState } from "react";
import Plan from "./screens/Plan";
import Trail from "./screens/Trail";
import Out from "./screens/Out";
import type { Prediction, Trip } from "./api";

type View = "plan" | "trail" | "out";

function viewFromHash(): View {
  if (location.hash === "#trail") return "trail";
  if (location.hash === "#out") return "out";
  return "plan";
}

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (v: View) => {
    location.hash = v;
    setView(v);
  };

  return (
    <main className="shell">
      <header className="top">
        <span className="logo">⛰ Turnaround</span>
        <span className="tag">know when to turn back</span>
      </header>

      {view === "plan" && (
        <Plan
          onStarted={(t, p) => {
            setTrip(t);
            setPrediction(p);
            go("trail");
          }}
        />
      )}

      {view === "trail" && trip && prediction && (
        <Trail
          trip={trip}
          prediction={prediction}
          onOut={(t) => {
            setTrip(t);
            go("out");
          }}
        />
      )}

      {view === "out" && trip && prediction && <Out trip={trip} prediction={prediction} onAgain={() => go("plan")} />}

      {(view === "trail" || view === "out") && !trip && (
        <section className="card">
          <p>No trip in progress — plan one first.</p>
          <button onClick={() => go("plan")}>Plan a hike</button>
        </section>
      )}

      <footer className="foot">
        runs entirely on our own machine · <a href="https://github.com/CodeNeuron58/Turnaround">source</a>
      </footer>
    </main>
  );
}
