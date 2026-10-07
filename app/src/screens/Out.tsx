import { useMemo } from "react";
import type { PlanData, RouteInfo } from "../App";
import type { Prediction, Trip } from "../api";
import { fmtHM, fmtNum, fmtTimeOfDay, startLabel } from "../format";

export default function Out({
  plan,
  trip,
  onAgain,
}: {
  plan: PlanData;
  trip: Trip;
  onAgain: () => void;
}) {
  const prediction: Prediction = plan.prediction;
  const route: RouteInfo = plan.route;
  const actualMin = trip.actual_min ?? 0;
  const delta = Math.round(actualMin - prediction.expected_min);
  const insideRange = actualMin >= prediction.p5_min && actualMin <= prediction.p95_min;

  const startedMs = useMemo(() => new Date(trip.started_at ?? Date.now()).getTime(), [trip.started_at]);
  const lo = prediction.p5_min;
  const hi = prediction.p95_min;
  const span = hi - lo || 1;
  const bandLeft = 0;
  const bandWidth = 100;
  const mark = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100 + (100 - bandWidth) / 2));

  const gpxUrl = useMemo(() => (plan.file ? URL.createObjectURL(plan.file) : null), [plan.file]);

  return (
    <div className="summary-col">
      <div className="checkin-banner">
        <div className="check">✓</div>
        <div>
          <h1>Check-in received</h1>
          <p>
            Your check-in reached the safety timer at {fmtTimeOfDay(trip.finished_at ?? Date.now())}.
            Nobody was alerted.
          </p>
        </div>
      </div>

      <div className="summary-meta">
        <div className="route">
          <span className="serif">{trip.name}</span>
          <span className="grade-badge">T{trip.t_grade}</span>
        </div>
        <span className="when">
          {startLabel(trip.started_at ?? "")} · {route.distance_km} km · {fmtNum(route.climb_m)} m climb
        </span>
      </div>

      <div className="pv-card">
        <div className="pv-title">Predicted vs actual</div>
        <div className="pv-grid">
          <div>
            <div className="k">Predicted</div>
            <div className="big">{fmtHM(prediction.expected_min)}</div>
            <div className="sub2">
              range {fmtHM(prediction.p5_min)} – {fmtHM(prediction.p95_min)}
            </div>
          </div>
          <div>
            <div className="k">Actual</div>
            <div className="big">{fmtHM(actualMin)}</div>
            <div className="sub2">
              {fmtTimeOfDay(trip.started_at ?? "")} – {fmtTimeOfDay(trip.finished_at ?? "")}
            </div>
          </div>
        </div>
        <div className="pv-viz">
          <div className="pv-strip">
            <div className="track" />
            <div className="band" style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }} />
            <div className="tick" style={{ left: `${mark(prediction.expected_min)}%`, background: "var(--green)" }} title="Predicted" />
            <div className="tick" style={{ left: `${mark(actualMin)}%`, background: "var(--amber)" }} title="Actual" />
          </div>
          <div className="pv-note">
            {insideRange ? (
              <>
                The model was <strong>{fmtHM(Math.abs(delta))} {delta >= 0 ? "optimistic" : "pessimistic"}</strong>.
                Still inside the predicted range.
              </>
            ) : (
              <>
                The model was <strong>{fmtHM(Math.abs(delta))} {delta >= 0 ? "optimistic" : "pessimistic"}</strong> —
                outside the predicted range. This hike is exactly the kind that improves it.
              </>
            )}
          </div>
        </div>
      </div>

      <div className="personalized">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M3 22 L10 14 L15 18 L25 6" stroke="#1F4D35" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M19 6h6v6" stroke="#1F4D35" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div>
          <div className="t">This hike just personalized your predictions</div>
          <div className="d">
            You were {delta >= 0 ? "a little slower" : "a little faster"} than the average hiker on
            T{trip.t_grade}-grade terrain. Future estimates for similar routes will account for it.
            Your data stays on this device.
          </div>
        </div>
      </div>

      <div className="summary-actions">
        <button className="btn-primary" onClick={onAgain}>
          Plan another hike <span>→</span>
        </button>
        {gpxUrl && (
          <a className="btn-secondary" href={gpxUrl} download={plan.file.name} style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>
            Download GPX track
          </a>
        )}
      </div>
    </div>
  );
}
