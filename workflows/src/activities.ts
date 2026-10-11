// Activities — the I/O side of the safety timer. Runs in the worker process,
// outside the workflow sandbox, so real clocks and files are fine here.

import { activityInfo } from "@temporalio/activity";
import { renderAlert, renderAllClear } from "./emails";
import { deliver } from "./mail";
import type { TripDetails } from "./workflows";

// per-workflow failure budget for the retry test — process-global counters
// would race between concurrent escalations
const failBudget = new Map<string, number>();

function workflowIdOf(trip: TripDetails): string {
  return activityInfo().workflowExecution?.workflowId ?? `trip-${trip.tripId}`;
}

/** Deliver the overdue alert.
 *
 *  Simulated flakiness for the retry test: set FAIL_FIRST_N=2 in the worker's
 *  environment and the first N attempts throw before succeeding. */
export async function escalateEmail(trip: TripDetails): Promise<{ delivered: string }> {
  const workflowId = workflowIdOf(trip);

  const failFirstN = Number(process.env.FAIL_FIRST_N ?? 0);
  if (failFirstN > 0) {
    const remaining = failBudget.get(workflowId) ?? failFirstN;
    if (remaining > 0) {
      failBudget.set(workflowId, remaining - 1);
      throw new Error(`simulated mail outage (${remaining} more failure(s) queued)`);
    }
  }

  return { delivered: await deliver(renderAlert(trip), `escalation-${workflowId}`) };
}

/** Tell the contact the hiker checked in after the alert went out. */
export async function sendAllClear(trip: TripDetails): Promise<{ delivered: string }> {
  return { delivered: await deliver(renderAllClear(trip), `allclear-${workflowIdOf(trip)}`) };
}
