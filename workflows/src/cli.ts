// CLI for the safety timer:
//   npx tsx src/cli.ts start --trip 1 [--deadline 30] [--late-window 3600] [--contact <email>] [--hiker "Name"]
//   npx tsx src/cli.ts checkin --workflow trip-1
//
// `start` pulls the trip (features, estimates, contact) from the prediction
// service and hands it to Temporal. The deadline is derived from the P90
// estimate unless overridden for testing. The workflow id is deterministic
// (trip-<id>) so a duplicate start can never create a second timer — Temporal
// enforces one open execution per id.

import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { checkedInSignal, tripWorkflow, type TripDetails } from "./workflows";

const SERVICE = process.env.PREDICTION_SERVICE_URL || "http://127.0.0.1:8000";
const TASK_QUEUE = "turnaround-trips";

interface TripRow {
  id: number;
  name: string;
  distance_km: number;
  climb_m: number;
  descent_m: number;
  highest_m: number;
  t_grade: number;
  expected_min: number;
  p90_min: number;
  started_at: string | null;
  status: string;
  contact_email: string | null;
}

const argv = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const token = argv[i];
  const inline = token.startsWith(`--${name}=`) ? token.split("=").slice(1).join("=") : undefined;
  if (inline !== undefined) return inline;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) return undefined;
  return next;
}

async function main(): Promise<void> {
  const [cmd] = argv;
  const client = new Client();

  if (cmd === "start") {
    const tripId = Number(arg("trip"));
    if (!tripId) throw new Error("--trip <id> is required");

    let trips: TripRow[];
    try {
      const r = await fetch(`${SERVICE}/trips`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      trips = await r.json();
    } catch (e) {
      throw new Error(`prediction service unreachable at ${SERVICE} — start it first (${e})`);
    }
    if (!Array.isArray(trips)) throw new Error(`unexpected response from ${SERVICE}/trips`);

    const trip = trips.find((t) => t.id === tripId);
    if (!trip) throw new Error(`trip ${tripId} not found in the prediction service`);
    if (trip.status !== "active") throw new Error(`trip ${tripId} is not active (status: ${trip.status})`);
    if (!trip.started_at) throw new Error(`trip ${tripId} has no start time`);

    // never alert a fictional address: no contact, no timer
    const contactEmail = trip.contact_email ?? arg("contact");
    if (!contactEmail) {
      throw new Error(
        `trip ${tripId} has no contact_email — refusing to start a timer that alerts nobody. Pass --contact <email> to set one.`,
      );
    }

    const startedMs = new Date(trip.started_at).getTime();
    const expectedBackIso = new Date(startedMs + trip.expected_min * 60_000).toISOString();
    const backByIso = new Date(startedMs + trip.p90_min * 60_000).toISOString();

    const overrideSec = arg("deadline") ? Number(arg("deadline")) : undefined;
    if (overrideSec !== undefined && (!Number.isFinite(overrideSec) || overrideSec <= 0)) {
      throw new Error("--deadline must be a positive number of seconds");
    }
    const deadlineMs = overrideSec
      ? overrideSec * 1000
      : Math.max(0, new Date(backByIso).getTime() - Date.now());

    const lateWindowSec = arg("late-window") ? Number(arg("late-window")) : 6 * 3600;
    if (!Number.isFinite(lateWindowSec) || lateWindowSec < 0) {
      throw new Error("--late-window must be a non-negative number of seconds");
    }

    const details: TripDetails = {
      tripId,
      hiker: arg("hiker") ?? "Your friend",
      routeName: trip.name,
      distanceKm: trip.distance_km,
      climbM: trip.climb_m,
      descentM: trip.descent_m,
      highestM: trip.highest_m,
      tGrade: trip.t_grade,
      startedAtIso: trip.started_at,
      expectedBackIso,
      backByIso,
      deadlineMs,
      lateCheckinWindowMs: lateWindowSec * 1000,
      contactEmail,
    };

    const workflowId = `trip-${tripId}`;
    try {
      await client.workflow.start(tripWorkflow, {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [details],
      });
      console.log(`safety timer running: ${workflowId}`);
      console.log(`  deadline in ${Math.round(deadlineMs / 1000)}s; check in with:`);
      console.log(`  npx tsx src/cli.ts checkin --workflow ${workflowId}`);
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        console.log(`timer already running for trip ${tripId} (${workflowId}) — one hiker, one timer`);
        return;
      }
      throw e;
    }
    return;
  }

  if (cmd === "checkin") {
    const workflowId = arg("workflow");
    if (!workflowId) throw new Error("--workflow <id> is required");
    try {
      await client.workflow.getHandle(workflowId).signal(checkedInSignal);
      console.log(`check-in sent: ${workflowId}`);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        console.error(`no running timer for ${workflowId} — it may have already completed or escalated`);
        return;
      }
      throw e;
    }
    return;
  }

  console.error("usage: tsx src/cli.ts start|checkin");
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
