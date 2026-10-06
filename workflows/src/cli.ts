// CLI for the safety timer:
//   npx tsx src/cli.ts start --trip 1 [--deadline 30] [--hiker "Name"]
//   npx tsx src/cli.ts checkin --workflow <workflow-id>
//
// `start` pulls the trip (features, estimates, contact) from the prediction
// service and hands it to Temporal. The deadline is derived from the P90
// estimate unless overridden for testing.

import { Client } from "@temporalio/client";
import { checkedInSignal, tripWorkflow, type TripDetails } from "./workflows";

const SERVICE = process.env.PREDICTION_SERVICE_URL ?? "http://127.0.0.1:8000";
const TASK_QUEUE = "turnaround-trips";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const [cmd] = process.argv.slice(2);
const client = new Client();

if (cmd === "start") {
  const tripId = Number(arg("trip"));
  if (!tripId) throw new Error("--trip <id> is required");

  const trips = await fetch(`${SERVICE}/trips`).then((r) => r.json());
  const trip = trips.find((t: { id: number }) => t.id === tripId);
  if (!trip) throw new Error(`trip ${tripId} not found in the prediction service`);
  if (trip.status !== "active") throw new Error(`trip ${tripId} is not active (status: ${trip.status})`);

  const startedMs = new Date(trip.started_at).getTime();
  const expectedBackIso = new Date(startedMs + trip.expected_min * 60_000).toISOString();
  const backByIso = new Date(startedMs + trip.p90_min * 60_000).toISOString();

  const overrideSec = arg("deadline") ? Number(arg("deadline")) : undefined;
  const deadlineMs = overrideSec
    ? overrideSec * 1000
    : Math.max(0, new Date(backByIso).getTime() - Date.now());

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
    contactEmail: trip.contact_email ?? "contact@example.com",
  };

  const workflowId = `trip-${tripId}-${Date.now()}`;
  await client.workflow.start(tripWorkflow, {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [details],
  });
  console.log(`safety timer running: ${workflowId}`);
  console.log(`  waiting until: ${new Date(Date.now() + deadlineMs).toISOString()} (deadline ${Math.round(deadlineMs / 1000)}s from now)`);
  console.log(`  check in with: npx tsx src/cli.ts checkin --workflow ${workflowId}`);
} else if (cmd === "checkin") {
  const workflowId = arg("workflow");
  if (!workflowId) throw new Error("--workflow <id> is required");
  await client.workflow.getHandle(workflowId).signal(checkedInSignal);
  console.log(`check-in sent: ${workflowId}`);
} else {
  console.error("usage: tsx src/cli.ts start|checkin");
  process.exit(1);
}
