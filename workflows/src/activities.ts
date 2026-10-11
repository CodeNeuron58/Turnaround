// Activities — the I/O side of the safety timer. Runs in the worker process,
// outside the workflow sandbox, so real clocks and files are fine here.

import { activityInfo } from "@temporalio/activity";
import { deliver, type Email } from "./mail";
import type { GeoPoint, TripDetails } from "./workflows";

// per-workflow failure budget for the retry test — process-global counters
// would race between concurrent escalations
const failBudget = new Map<string, number>();

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function where(p: GeoPoint): string {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} — https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`;
}

// a drill must never read as the real thing
const DRILL_NOTE = [
  `THIS IS A PLANNED DRILL — no action needed. The deadline was shortened on`,
  `purpose; a real alert looks exactly like the rest of this email.`,
  "",
];

function renderAlert(trip: TripDetails): Email {
  const overdueMin = Math.max(0, Math.round((Date.now() - new Date(trip.backByIso).getTime()) / 60000));
  const lines = [
    ...(trip.drill ? DRILL_NOTE : []),
    `${trip.hiker} listed you as their emergency contact in Turnaround, the hiking`,
    `companion app. They started a hike and have not checked in, well past the`,
    `time the app calculated they should be back.`,
    "",
    `  Hiker:             ${trip.hiker}`,
    `  Route:             ${trip.routeName} (grade T${trip.tGrade})`,
    `  Distance:          ${trip.distanceKm} km, ${trip.climbM} m of climbing, high point ${trip.highestM} m`,
    ...(trip.trailhead ? [`  Set off from:      ${where(trip.trailhead)}`] : []),
    ...(trip.routeCenter ? [`  Middle of route:   ${where(trip.routeCenter)}`] : []),
    `  Started:           ${fmtLocal(trip.startedAtIso)}`,
    `  Expected back:     ${fmtLocal(trip.expectedBackIso)} (typical estimate${trip.breaksMin ? `, ${trip.breaksMin} min of breaks included` : ""})`,
    `  Should be back by: ${fmtLocal(trip.backByIso)} (cautious estimate)`,
    ...(trip.drill ? [] : [`  Overdue:           ${overdueMin} min past that`]),
    ...(trip.sunsetIso ? [`  Sunset:            ${fmtLocal(trip.sunsetIso)}`] : []),
    ...(trip.rainChancePct != null ? [`  Rain chance:       ${Math.round(trip.rainChancePct)}%`] : []),
    "",
    `If you can reach them, a phone call may be all it takes. If not, the route`,
    `above is the one they planned to follow, starting from the first location.`,
    `If they check in, you'll get a second email saying they're safe.`,
    "",
    `— Turnaround (sent automatically, from their own machine)`,
  ];
  return {
    to: trip.contactEmail,
    subject: `${trip.drill ? "[DRILL] " : ""}Turnaround alert — ${trip.hiker} is overdue on "${trip.routeName}"`,
    text: lines.join("\n"),
  };
}

function renderAllClear(trip: TripDetails): Email {
  const lines = [
    `${trip.hiker} just checked in from "${trip.routeName}" — they're off the trail.`,
    `You can stand down; ignore our earlier overdue alert.`,
    "",
    `  Started:     ${fmtLocal(trip.startedAtIso)}`,
    `  Checked in:  ${fmtLocal(new Date().toISOString())}`,
    "",
    `— Turnaround (sent automatically, from their own machine)`,
  ];
  return {
    to: trip.contactEmail,
    subject: `${trip.drill ? "[DRILL] " : ""}Turnaround — ${trip.hiker} is safe`,
    text: lines.join("\n"),
  };
}

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
