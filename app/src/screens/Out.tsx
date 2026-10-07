import { useMemo } from "react";
import type { PlanData } from "../App";
import type { CheckinResult } from "../api";
import { fmtHM, fmtNum, fmtTimeOfDay, startLabel } from "../format";

export default function Out({
  plan,
  result,
  onAgain,
}: {
  plan: PlanData;
  result: CheckinResult;
  onAgain: () => void;
}) {
  const { route } = plan;
  const breaks = result.breaks_min ?? 0;
  // the clock ran through the breaks, so the prediction gets them too
  const predicted = result.expected_min + breaks;
  const lo = result.p5_min + breaks;
  const hi = result.p95_min + breaks;
  const actualMin = result.actual_min ?? 0;
  const delta = Math.round(actualMin - predicted);
  const insideRange = actualMin >= lo && actualMin <= hi;
  const span = hi - lo || 1;
  const mark = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));

  const gpxUrl = useMemo(() => (plan.file ? URL.createObjectURL(plan.file) : null), [plan.file]);

  const signalFailed = result.checkin_signal.startsWith("failed");
  const banner = signalFailed
    ? {
        warn: true,
        title: "Checked in — but the timer didn't hear it",
        body: (
          <>
            Your time is saved, but the safety timer couldn't be reached
            {result.alert_at ? <>, so {result.contact_email} may still be emailed at {fmtTimeOfDay(result.alert_at)}</> : null}.
            Text them that you're safe. ({result.checkin_signal.replace(/^failed:\s*/, "")})
          </>
        ),
      }
    : result.alert_fired
      ? {
          warn: true,
          title: "You're checked in",
          body: (
            <>
              Your check-in came after {result.alert_at ? fmtTimeOfDay(result.alert_at) : "the alert time"}, so{" "}
              {result.contact_email} was emailed. An all-clear is on its way to them now.
            </>
          ),
        }
      : result.checkin_signal === "no_timer"
        ? {
            warn: true,
            title: "Checked in",
            body: <>No safety timer was running for this trip, so nobody was watching — or alerted.</>,
          }
        : {
            warn: false,
            title: "Check-in received",
            body: (
              <>
                Your check-in reached the safety timer at {fmtTimeOfDay(result.finished_at ?? Date.now())}. Nobody was
                alerted.
              </>
            ),
          };

  const ratio = result.trained && result.moving_min && result.crowd_min ? result.moving_min / result.crowd_min : null;
  const pct = (x: number) => Math.round(Math.abs(x - 1) * 100);
  const f = result.your_pace_factor;

  return (
    <div className="summary-col">
      <div className={`checkin-banner ${banner.warn ? "warn" : ""}`}>
        <div className="check">{banner.warn ? "!" : "✓"}</div>
        <div>
          <h1>{banner.title}</h1>
          <p>{banner.body}</p>
        </div>
      </div>

      <div className="summary-meta">
        <div className="route">
          <span className="serif">{result.name}</span>
          <span className="grade-badge">T{result.t_grade}</span>
          {result.drill && <span className="drill-chip">DRILL</span>}
        </div>
        <span className="when">
          {startLabel(result.started_at ?? "")} · {route.distance_km} km · {fmtNum(route.climb_m)} m climb
        </span>
      </div>

      <div className="pv-card">
        <div className="pv-title">Predicted vs actual</div>
        <div className="pv-grid">
          <div>
            <div className="k">Predicted{breaks ? `, with ${fmtHM(breaks)} of breaks` : ""}</div>
            <div className="big">{fmtHM(predicted)}</div>
            <div className="sub2">
              range {fmtHM(lo)} – {fmtHM(hi)}
            </div>
          </div>
          <div>
            <div className="k">Actual</div>
            <div className="big">{fmtHM(actualMin)}</div>
            <div className="sub2">
              {fmtTimeOfDay(result.started_at ?? "")} – {fmtTimeOfDay(result.finished_at ?? "")}
            </div>
          </div>
        </div>
        <div className="pv-viz">
          <div className="pv-strip">
            <div className="track" />
            <div className="band" style={{ left: "0%", width: "100%" }} />
            <div className="tick" style={{ left: `${mark(predicted)}%`, background: "var(--green)" }} title="Predicted" />
            <div className="tick" style={{ left: `${mark(actualMin)}%`, background: "var(--amber)" }} title="Actual" />
          </div>
          <div className="pv-note">
            The model was <strong>{fmtHM(Math.abs(delta))} {delta >= 0 ? "optimistic" : "pessimistic"}</strong>
            {insideRange ? ". Still inside the predicted range." : " — outside the predicted range."}
          </div>
        </div>
      </div>

      <div className="personalized">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M3 22 L10 14 L15 18 L25 6" stroke="#1F4D35" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M19 6h6v6" stroke="#1F4D35" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div>
          {ratio != null ? (
            <>
              <div className="t">This hike just tuned your predictions</div>
              <div className="d">
                About {fmtHM(result.moving_min!)} moving (the clock minus your planned breaks) against the
                crowd's {fmtHM(result.crowd_min!)} for this route: {pct(ratio)}% {ratio > 1 ? "slower" : "faster"}.
                Your pace factor is now ×{f.toFixed(2)} from {result.your_pace_hikes} hike
                {result.your_pace_hikes === 1 ? "" : "s"}, so estimates for you run {pct(f)}%{" "}
                {f >= 1 ? "longer" : "shorter"} than the crowd's. Your data stays on this device.
              </div>
            </>
          ) : (
            <>
              <div className="t">This one didn't change your predictions</div>
              <div className="d">
                {(result.moving_min ?? 0) < 15
                  ? "Under 15 minutes of moving time is too short to learn from"
                  : "This hike fell outside what the model can learn from"}
                , so your pace factor stays ×{f.toFixed(2)}
                {result.your_pace_hikes ? ` from ${result.your_pace_hikes} hike${result.your_pace_hikes === 1 ? "" : "s"}` : ""}.
              </div>
            </>
          )}
        </div>
      </div>

      <div className="summary-actions">
        <button className="btn-primary" onClick={onAgain}>
          Plan another hike <span>→</span>
        </button>
        {gpxUrl && plan.file && (
          <a className="btn-secondary" href={gpxUrl} download={plan.file.name} style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>
            Download GPX track
          </a>
        )}
      </div>
    </div>
  );
}
