// The Turnaround trip workflow — the promise the app makes to every hiker:
//
//   "You started your trip. I will wait for your check-in until the cautious
//    estimate says you should be back. If that moment passes and you haven't
//    checked in, I will tell your person where you are, what your plan was,
//    and when you were expected back — no matter what happens to this server."
//
// Deterministic by design: no I/O in here. The deadline is a duration measured
// from workflow start (the moment the hiker headed out), and the only branch
// is the check-in signal versus that timer.

import { defineSignal, setHandler, condition, proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

export const checkedInSignal = defineSignal("trip.checkedIn");

const { escalateEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
  },
});

export interface TripDetails {
  tripId: number;
  hiker: string;
  routeName: string;
  distanceKm: number;
  climbM: number;
  descentM: number;
  highestM: number;
  tGrade: number;
  startedAtIso: string;
  expectedBackIso: string; // start + median estimate
  backByIso: string; // start + P90 estimate — the turn-back line
  deadlineMs: number; // how long to wait for the check-in
  contactEmail: string;
  sunsetIso?: string | null;
  rainChancePct?: number | null;
}

export async function tripWorkflow(trip: TripDetails): Promise<string> {
  let checkedIn = false;
  setHandler(checkedInSignal, () => {
    checkedIn = true;
  });

  const madeIt = await condition(() => checkedIn, trip.deadlineMs);

  if (madeIt) {
    return "checked_in_on_time";
  }

  // The check-in window closed. Escalate — the activity retries on failure,
  // so a flaky mail server can't silence the promise.
  await escalateEmail(trip);
  return "escalated";
}
