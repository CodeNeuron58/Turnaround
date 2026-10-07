import { type Prediction, type Trip } from "../api";

export default function Out({
  trip,
  prediction,
  onAgain,
}: {
  trip: Trip;
  prediction: Prediction;
  onAgain: () => void;
}) {
  const actualMin = trip.actual_min ?? 0;
  const expected = Math.round(prediction.expected_min);
  const delta = Math.round(actualMin - expected);

  return (
    <section className="card">
      <h2>Welcome back 🎉</h2>
      <p className="note">your check-in reached the safety timer — nobody was alerted</p>

      <div className="stat">
        <span className="k">you predicted</span>
        <span className="v">{expected} min <small>(turn-back {Math.round(trip.p90_min)} min)</small></span>
      </div>
      <div className="stat">
        <span className="k">you actually took</span>
        <span className="v big">{Math.round(actualMin)} min</span>
      </div>
      <div className="stat">
        <span className="k">the model was</span>
        <span className="v">
          {delta === 0 ? "spot on" : delta > 0 ? `${delta} min optimistic` : `${-delta} min pessimistic`}
        </span>
      </div>

      <p className="note">
        this hike just made every future prediction a little more yours — it joined
        the model's context the moment you checked in
      </p>

      <button className="primary" onClick={onAgain}>Plan another hike</button>
      <p className="note">trip #{trip.id} recorded {new Date(trip.finished_at ?? "").toLocaleString()}</p>
    </section>
  );
}
