// CLI: plan a trip end-to-end and save the artifacts.
//   npx tsx agent/src/cli.ts --gpx data/test-route.gpx --grade 3 --start "2026-10-10T07:30" [--breaks 30]
// Artifacts land in agent/output (gitignored): plan.json, briefing.txt, briefing.wav.
// plan.json is written as soon as the core flow (route + prediction + turn-back)
// succeeds — briefing/TTS failures are recorded in it, not thrown away.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planTrip } from "./agent.ts";

const argv = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const inline = argv[i].startsWith(`--${name}=`) ? argv[i].split("=").slice(1).join("=") : undefined;
  if (inline !== undefined) return inline;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) return undefined; // valueless flag
  return next;
}

function hasFlag(name: string): boolean {
  return argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

if (hasFlag("help") || argv.length === 0) {
  console.log(`usage: npx tsx agent/src/cli.ts --gpx <file.gpx> [--grade 1-6] [--start "YYYY-MM-DDTHH:mm"] [--breaks min] [--out dir] [--no-speak] [--help]`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const gpxPath = arg("gpx");
if (!gpxPath) {
  console.error("--gpx <file.gpx> is required");
  process.exit(1);
}

const gradeArg = arg("grade");
let tGrade: number | undefined;
if (gradeArg !== undefined) {
  tGrade = Number(gradeArg);
  if (!Number.isInteger(tGrade) || tGrade < 1 || tGrade > 6) {
    console.error(`--grade must be an integer 1-6 (got "${gradeArg}")`);
    process.exit(1);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const defaultStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
const startIso = arg("start") ?? defaultStart;
if (Number.isNaN(new Date(startIso).getTime())) {
  console.error(`--start is not a parseable time: "${startIso}" (use "YYYY-MM-DDTHH:mm")`);
  process.exit(1);
}

const breaksArg = arg("breaks");
const breaksMin = breaksArg === undefined ? 30 : Number(breaksArg);
if (!Number.isFinite(breaksMin) || breaksMin < 0 || breaksMin > 480) {
  console.error(`--breaks must be 0-480 minutes (got "${breaksArg}")`);
  process.exit(1);
}

const outDir = path.resolve(arg("out") ?? path.join(import.meta.dirname, "..", "output"));
mkdirSync(outDir, { recursive: true });

try {
  const plan = await planTrip({
    gpxPath,
    tGrade,
    startIso,
    breaksMin,
    speakWav: hasFlag("no-speak") ? undefined : path.join(outDir, "briefing.wav"),
  });

  // the core result is written before anything can spoil it; briefing problems
  // are recorded inside plan.json instead of losing the whole run
  writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  if (plan.briefing) writeFileSync(path.join(outDir, "briefing.txt"), plan.briefing + "\n");

  if (!plan.weather.ok) {
    console.warn(`note: weather unavailable (${plan.weather.error ?? "unknown reason"}) — sunset margin unknown`);
  }

  console.log(JSON.stringify({ route: plan.route, prediction: plan.prediction, weather: plan.weather, turnBack: plan.turnBack }, null, 2));
  if (plan.briefing) console.log(`\n--- Briefing ---\n${plan.briefing}`);
  if (plan.briefingError) console.warn(`\nbriefing step failed (plan is still complete): ${plan.briefingError}`);
  console.log(`\nartifacts: ${path.join(outDir, "plan.json")}${plan.briefing ? ", briefing.txt" : ""}${plan.wav ? ", briefing.wav" : ""}`);
} catch (e) {
  console.error(`plan failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
