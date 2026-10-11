// One test email through the same delivery path the safety timer uses.
//   npm run test-email -w @turnaround/workflows -- you@example.com
// Reads BREVO_API_KEY / BREVO_SENDER_EMAIL from the repo-root .env. With no key
// set, it only writes workflows/outbox/test-email.txt.

import { fileURLToPath } from "node:url";
import { deliver } from "./mail";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  /* no .env */
}

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error("usage: npm run test-email -w @turnaround/workflows -- you@example.com");
  process.exit(1);
}

const viaBrevo = Boolean(process.env.BREVO_API_KEY?.trim());
console.log(`sending a test email to ${to} via ${viaBrevo ? "Brevo" : "the local outbox only (BREVO_API_KEY is not set)"}...`);
try {
  const result = await deliver(
    {
      to,
      subject: "Turnaround test email",
      text: [
        "If you can read this, Turnaround can reach this inbox.",
        "",
        "This is the same path the safety timer uses for an overdue alert and",
        "for the all-clear that follows a late check-in.",
        "",
        "— Turnaround (sent from the hiker's own machine)",
      ].join("\n"),
    },
    "test-email",
  );
  console.log(`delivered: ${result}`);
  if (viaBrevo) console.log(`check ${to}'s inbox — and its spam folder the first time`);
} catch (e) {
  console.error(`failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
