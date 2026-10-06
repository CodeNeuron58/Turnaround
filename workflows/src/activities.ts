// Activities — the I/O side of the safety timer. Runs in the worker process,
// outside the workflow sandbox, so real clocks and files are fine here.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activityInfo } from "@temporalio/activity";
import type { TripDetails } from "./workflows";

// anchored to this file, not the worker's cwd
const OUTBOX_DIR = process.env.OUTBOX_DIR ?? fileURLToPath(new URL("../outbox", import.meta.url));

// per-workflow failure budget for the retry test — process-global counters
// would race between concurrent escalations
const failBudget = new Map<string, number>();

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function renderEmail(trip: TripDetails): string {
  const lines = [
    `TO: ${trip.contactEmail}`,
    `SUBJECT: Turnaround alert — ${trip.hiker} is overdue on "${trip.routeName}"`,
    "",
    `Your friend listed you as their emergency contact in Turnaround, the hiking`,
    `companion app. They started a hike and have not checked in within the`,
    `cautious window the app calculated for them.`,
    "",
    `  Hiker:            ${trip.hiker}`,
    `  Route:            ${trip.routeName} (grade T${trip.tGrade})`,
    `  Distance:         ${trip.distanceKm} km, ${trip.climbM} m of climbing, high point ${trip.highestM} m`,
    `  Started:          ${fmtLocal(trip.startedAtIso)}`,
    `  Expected back:    ${fmtLocal(trip.expectedBackIso)} (typical estimate)`,
    `  Should be back by:${fmtLocal(trip.backByIso)} (cautious estimate)`,
    `  Overdue by:       ${Math.round((Date.now() - new Date(trip.startedAtIso).getTime() - trip.deadlineMs) / 60000)} min past the alert deadline`,
    ...(trip.sunsetIso ? [`  Sunset:           ${fmtLocal(trip.sunsetIso)}`] : []),
    ...(trip.rainChancePct != null ? [`  Rain chance:      ${trip.rainChancePct}%`] : []),
    "",
    `If you can reach them, a phone call may be all it takes. If not, consider`,
    `the route above — it is the one they planned to follow.`,
    "",
    `— Turnaround (sent automatically, from their own machine)`,
  ];
  return lines.join("\n");
}

/** Deliver the escalation. While no SMTP account is wired up, the email is
 *  written to a local outbox (full .eml-style content) — swapping in nodemailer
 *  later only changes this one function.
 *
 *  Simulated flakiness for the retry test: set FAIL_FIRST_N=2 in the worker's
 *  environment and the first N attempts throw before succeeding. */
export async function escalateEmail(trip: TripDetails): Promise<{ delivered: string }> {
  const workflowId = activityInfo().workflowExecution?.workflowId ?? `trip-${trip.tripId}`;

  const failFirstN = Number(process.env.FAIL_FIRST_N ?? 0);
  if (failFirstN > 0) {
    const remaining = failBudget.get(workflowId) ?? failFirstN;
    if (remaining > 0) {
      failBudget.set(workflowId, remaining - 1);
      throw new Error(`simulated smtp outage (${remaining} more failure(s) queued)`);
    }
  }

  mkdirSync(OUTBOX_DIR, { recursive: true });
  // the filename comes from the execution, not the clock: a redelivered
  // activity attempt overwrites the same file instead of duplicating the alert
  const file = path.join(OUTBOX_DIR, `escalation-${workflowId}.txt`);
  writeFileSync(file, renderEmail(trip), "utf-8");
  return { delivered: `outbox:${file}` };
}
