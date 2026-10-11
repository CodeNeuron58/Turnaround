// Mail delivery — the one place an email leaves the worker.
//
// Every message is written to the local outbox (a record on this machine).
// When BREVO_API_KEY is set it is also sent through Brevo's transactional API.
// A failed send throws, so the Temporal activity retries it with backoff. An
// attempt that reached Brevo but died before reporting back can send twice —
// for a safety alert, twice beats never.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

// read per call: the worker loads .env after this module's imports have run
const outboxDir = () => process.env.OUTBOX_DIR ?? fileURLToPath(new URL("../outbox", import.meta.url));
const brevoUrl = () => process.env.BREVO_API_URL ?? "https://api.brevo.com/v3/smtp/email";

/** The file name comes from the execution, not the clock, so a redelivered
 *  activity attempt overwrites the local copy instead of duplicating it. */
function writeOutbox(email: Email, fileStem: string): string {
  const dir = outboxDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fileStem}.txt`);
  writeFileSync(file, [`TO: ${email.to}`, `SUBJECT: ${email.subject}`, "", email.text].join("\n"), "utf-8");
  return file;
}

async function sendViaBrevo(email: Email, apiKey: string, sender: string): Promise<string> {
  const res = await fetch(brevoUrl(), {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME || "Turnaround", email: sender },
      to: [{ email: email.to }],
      subject: email.subject,
      textContent: email.text,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    // Brevo's error body names the problem (bad key, unverified sender,
    // unrecognised IP); the key itself is never echoed
    throw new Error(`brevo rejected the email: ${res.status} ${body.slice(0, 300)}`);
  }
  let id = "";
  try {
    id = JSON.parse(body).messageId ?? "";
  } catch {
    /* a 2xx without JSON still means accepted */
  }
  return `brevo:${id || res.status}`;
}

export async function deliver(email: Email, fileStem: string): Promise<string> {
  const file = writeOutbox(email, fileStem);
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) return `outbox:${file}`;
  const sender = process.env.BREVO_SENDER_EMAIL?.trim();
  if (!sender) {
    throw new Error("BREVO_API_KEY is set but BREVO_SENDER_EMAIL is not — set it to the sender you verified in Brevo");
  }
  return `${await sendViaBrevo(email, apiKey, sender)} · outbox:${file}`;
}
