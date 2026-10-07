// The Temporal worker — runs the workflows and activities. Kill it mid-trip and
// start it again: Temporal replays the workflow exactly where it left off.

import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as activities from "./activities";

try {
  // the repo-root .env, whatever directory the worker was started from
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  /* no .env, use defaults */
}

async function run(): Promise<void> {
  const worker = await Worker.create({
    taskQueue: "turnaround-trips",
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
  });
  console.log("[turnaround] worker up — watching task queue 'turnaround-trips'");
  await worker.run();
}

run().catch((err) => {
  console.error("[turnaround] worker crashed:", err);
  process.exit(1);
});
