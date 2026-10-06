// CLI: plan a trip end-to-end and save the artifacts.
//   npx tsx agent/src/cli.ts --gpx data/test-route.gpx --grade 3 --start "2026-10-10T07:30"
// Artifacts land in --out (default agent/output): plan.json, briefing.txt, briefing.wav

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planTrip } from "./agent.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const gpxPath = arg("gpx");
if (!gpxPath) {
  console.error("usage: tsx src/cli.ts --gpx <file.gpx> [--grade 1-6] [--start ISO] [--out dir] [--no-speak]");
  process.exit(1);
}

const startIso = arg("start") ?? new Date().toISOString();
const outDir = path.resolve(arg("out") ?? path.join(import.meta.dirname, "..", "output"));
mkdirSync(outDir, { recursive: true });

const plan = await planTrip({
  gpxPath,
  tGrade: arg("grade") ? Number(arg("grade")) : undefined,
  startIso,
  speakWav: arg("no-speak") ? undefined : path.join(outDir, "briefing.wav"),
});

writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
writeFileSync(path.join(outDir, "briefing.txt"), plan.briefing + "\n");

console.log(JSON.stringify({ route: plan.route, prediction: plan.prediction, weather: plan.weather, turnBack: plan.turnBack }, null, 2));
console.log(`\n--- Briefing ---\n${plan.briefing}`);
console.log(`\nartifacts: ${path.join(outDir, "plan.json")}, briefing.txt${plan.wav ? `, briefing.wav` : ""}`);
