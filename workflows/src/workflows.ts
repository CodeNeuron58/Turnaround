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
  startToCloseTimeout: "2 minutes",
  // total escalation budget: real SMTP outages last minutes-to-hours, so the
  // activity keeps retrying (5s doubling to 5m caps) for up to 6 hours
  scheduleToCloseTimeout: "6 hours",
  retry: {
    maximumAttempts: 20,
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
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
  lateCheckinWindowMs: number; // how long to stay open after an alert, for "I'm safe"
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

  // The check-in window closed. Escalate — the activity retries through mail
  // outages for hours. If delivery ultimately fails, say so honestly instead
  // of crashing or pretending.
  try {
    await escalateEmail(trip);
  } catch {
    return "escalation_failed";
  }

  // A hiker who checks in after the alert — or during its retries — can still
  // say "I'm safe"; the workflow stays open for that window and closes honestly.
  const late = await condition(() => checkedIn, trip.lateCheckinWindowMs);
  return late ? "escalated_late_checkin" : "escalated";
}
