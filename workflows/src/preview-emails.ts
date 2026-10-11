// Render the alert and the all-clear for a sample trip, to see the design
// without running a drill.
//   npm run preview-emails -w @turnaround/workflows                         -> outbox/preview-*.html
//   npm run preview-emails -w @turnaround/workflows -- --send you@example.com  (sends both, marked [PREVIEW])

import { fileURLToPath } from "node:url";
import { renderAlert, renderAllClear } from "./emails";
import { deliver } from "./mail";
import type { TripDetails } from "./workflows";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  /* no .env */
}

const sendTo = process.argv.includes("--send") ? process.argv[process.argv.indexOf("--send") + 1] : undefined;
const start = Date.now() - 5.5 * 3600_000;
const iso = (offsetMin: number) => new Date(start + offsetMin * 60_000).toISOString();

const trip: TripDetails = {
  tripId: 0,
  hiker: "Biprayan",
  routeName: "Sample ridge loop",
  distanceKm: 10.37,
  climbM: 786.2,
  descentM: 786.2,
  highestM: 2133,
  tGrade: 3,
  startedAtIso: iso(0),
  expectedBackIso: iso(282),
  backByIso: iso(311),
  deadlineMs: 0,
  lateCheckinWindowMs: 0,
  contactEmail: sendTo ?? "friend@example.com",
  breaksMin: 30,
  trailhead: { lat: 27.788, lon: 85.365 },
  routeCenter: { lat: 27.7883, lon: 85.3822 },
  sunsetIso: iso(700),
  rainChancePct: 24,
};

const emails = [
  { stem: "preview-alert", email: renderAlert(trip) },
  { stem: "preview-allclear", email: renderAllClear(trip) },
];
for (const { stem, email } of emails) {
  if (sendTo) email.subject = `[PREVIEW] ${email.subject}`;
  else delete process.env.BREVO_API_KEY; // render only
  console.log(`${stem}: ${await deliver(email, stem)}`);
}
