/**
 * Pome bundled example: gmail-retry-notify.
 *
 * A model-driven Gmail notification agent (Vercel AI SDK) over the Gmail twin's
 * REST surface. It must send a short announcement to each recipient named in
 * POME_TASK.
 *
 * FAILURE CLASS: retry / partial failure. The task seeds the Gmail twin with a
 * named `rate-limited` fault: the first couple of sends succeed, the next few
 * return HTTP 429 RESOURCE_EXHAUSTED, then sends recover. A naive agent that
 * does not retry leaves those recipients unsent (partial failure) — or blindly
 * re-sends the whole batch and duplicates the ones that already went out. The
 * fix is the one-line swap from RETRY_RULE_V1 (red) to RETRY_RULE_V2 (green):
 * retry throttled sends with backoff, but only the ones that actually failed.
 *
 * Standard Pome agent contract (env injected by `pome run`):
 *   POME_TASK             the instruction (names the recipients)
 *   POME_GMAIL_REST_URL   session-scoped REST base for the Gmail twin
 *   POME_AUTH_TOKEN       bearer token for the twin session
 * POME_PREFLIGHT=1 → print "preflight ok" and exit, touching no network/model.
 */

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

// --- the one-line fix: swap V1 (red) for V2 (green) -------------------------
const RETRY_RULE_V1 = "Send the announcement to each recipient exactly once.";
const RETRY_RULE_V2 =
  "Send the announcement to each recipient exactly once. If a send fails with a " +
  "rate-limit / transient error (HTTP 429), wait briefly and retry ONLY that " +
  "recipient, up to 5 attempts, before giving up. NEVER re-send a recipient " +
  "whose send already succeeded. In your final summary, report exactly which " +
  "recipients were delivered and which (if any) were not.";
const RETRY_RULE = RETRY_RULE_V1; // ← green variant: change to RETRY_RULE_V2
// ---------------------------------------------------------------------------

const task = requiredEnv("POME_TASK");
const restUrl = requiredEnv("POME_GMAIL_REST_URL").replace(/\/$/, "");
const authToken = process.env.POME_AUTH_TOKEN ?? process.env.POME_GMAIL_TOKEN;
const modelSlug = (process.env.GMAIL_AGENT_MODEL ?? "anthropic/claude-opus-4-8").trim();
const maxSteps = Number(process.env.GMAIL_AGENT_MAX_STEPS ?? 30);

const system = [
  "You are an automated email notification agent for a Gmail mailbox.",
  RETRY_RULE,
  "Work autonomously. Finish once you have attempted every recipient.",
].join("\n");

let sender = "pome-agent@pome-twin.test"; // resolved from the live profile in main()

const tools = {
  send_email: tool({
    description: "Send a plain-text email from the mailbox to one recipient.",
    inputSchema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    }),
    execute: ({ to, subject, body }: { to: string; subject: string; body: string }) => {
      const raw = toBase64Url(buildMime({ from: sender, to, subject, body }));
      return gmail(`/gmail/v1/users/me/messages/send`, "POST", { raw });
    },
  }),
  list_sent: tool({
    description: "List messages already sent from the mailbox (to check what succeeded).",
    inputSchema: z.object({}),
    execute: () => gmail(`/gmail/v1/users/me/messages?labelIds=SENT`),
  }),
};

await main();

async function main() {
  const profile = await gmail(`/gmail/v1/users/me/profile`);
  if (profile && typeof profile === "object" && "emailAddress" in profile) {
    sender = String((profile as { emailAddress: string }).emailAddress);
  }
  const model = await resolveModel(modelSlug);
  const result = await generateText({
    model,
    system,
    prompt: task,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });
  console.log(
    JSON.stringify({
      task,
      model: modelSlug,
      steps: result.steps.length,
      summary: result.text || "Agent finished.",
    }),
  );
}

async function gmail(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${restUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Hand the model the error (incl. 429) instead of throwing, so it can retry.
  if (!res.ok) return { ok: false, status: res.status, error: text || res.statusText };
  return text ? JSON.parse(text) : null;
}

function buildMime({ from, to, subject, body }: { from: string; to: string; subject: string; body: string }): string {
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\r\n",
  );
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function resolveModel(slug: string): Promise<Parameters<typeof generateText>[0]["model"]> {
  if (process.env.AI_GATEWAY_API_KEY) return slug;
  const id = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") })(id);
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}
