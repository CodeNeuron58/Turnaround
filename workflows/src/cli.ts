// CLI for the safety timer:
//   npx tsx src/cli.ts start --trip 1 [--deadline 30] [--late-window 3600] [--contact <email>] [--hiker "Name"]
//   npx tsx src/cli.ts checkin --workflow trip-1
//
// `start` pulls the trip (features, timeline, contact) from the prediction
// service and hands it to Temporal. The deadline is the trip's alert moment
// (P95 + breaks + grace) unless overridden for testing. The workflow id is
// deterministic (trip-<id>) so a duplicate start can never create a second
// timer — Temporal enforces one open execution per id. The service arms timers
// itself on POST /trips/{id}/start; this CLI is for tests.

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
  started_at: string | null;
  status: string;
  contact_email: string | null;
  hiker_name: string | null;
  breaks_min: number;
  lat: number | null;
  lon: number | null;
  start_lat: number | null;
  start_lon: number | null;
  sunset_at: string | null;
  rain_pct: number | null;
  // timeline, present once the trip has started
  expected_back_at?: string;
  back_by_at?: string;
  alert_at?: string;
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

    let r: Response;
    try {
      r = await fetch(`${SERVICE}/trips/${tripId}`, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new Error(`prediction service unreachable at ${SERVICE} — start it first (${e})`);
    }
    if (r.status === 404) throw new Error(`trip ${tripId} not found in the prediction service`);
    if (!r.ok) throw new Error(`prediction service: HTTP ${r.status}`);
    const trip: TripRow = await r.json();
    if (trip.status !== "active") throw new Error(`trip ${tripId} is not active (status: ${trip.status})`);
    if (!trip.started_at || !trip.back_by_at || !trip.alert_at || !trip.expected_back_at) {
      throw new Error(`trip ${tripId} has no start time`);
    }

    // never alert a fictional address: no contact, no timer
    const contactEmail = trip.contact_email ?? arg("contact");
    if (!contactEmail) {
      throw new Error(
        `trip ${tripId} has no contact_email — refusing to start a timer that alerts nobody. Pass --contact <email> to set one.`,
      );
    }

    const overrideSec = arg("deadline") ? Number(arg("deadline")) : undefined;
    if (overrideSec !== undefined && (!Number.isFinite(overrideSec) || overrideSec <= 0)) {
      throw new Error("--deadline must be a positive number of seconds");
    }
    const deadlineMs = overrideSec
      ? overrideSec * 1000
      : Math.max(1000, new Date(trip.alert_at).getTime() - Date.now());

    const lateWindowSec = arg("late-window") ? Number(arg("late-window")) : 6 * 3600;
    if (!Number.isFinite(lateWindowSec) || lateWindowSec < 0) {
      throw new Error("--late-window must be a non-negative number of seconds");
    }

    const details: TripDetails = {
      tripId,
      hiker: arg("hiker") ?? trip.hiker_name ?? "Your friend",
      routeName: trip.name,
      distanceKm: trip.distance_km,
      climbM: trip.climb_m,
      descentM: trip.descent_m,
      highestM: trip.highest_m,
      tGrade: trip.t_grade,
      startedAtIso: trip.started_at,
      expectedBackIso: trip.expected_back_at,
      backByIso: trip.back_by_at,
      deadlineMs,
      lateCheckinWindowMs: lateWindowSec * 1000,
      contactEmail,
      breaksMin: trip.breaks_min,
      trailhead: trip.start_lat != null && trip.start_lon != null ? { lat: trip.start_lat, lon: trip.start_lon } : null,
      routeCenter: trip.lat != null && trip.lon != null ? { lat: trip.lat, lon: trip.lon } : null,
      sunsetIso: trip.sunset_at,
      rainChancePct: trip.rain_pct,
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
