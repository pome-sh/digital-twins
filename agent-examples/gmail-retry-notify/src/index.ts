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

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

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

const SYSTEM = [
  "You are an automated email notification agent for a Gmail mailbox.",
  RETRY_RULE,
  "Work autonomously. Finish once you have attempted every recipient.",
].join("\n");

const DEFAULT_SENDER = "pome-agent@pome-twin.test";

/**
 * One Gmail-twin fetch helper, shared by the tool table and by `main()`'s
 * profile lookup, so neither carries its own copy of the auth + error handling.
 *
 * A non-2xx (including the 429 this example's whole subject is about) is handed
 * BACK as a value instead of thrown, so the model can retry. That is deliberate
 * — and it is also why F-1152's gate reads the response status off the wire
 * rather than watching for a thrown error.
 */
function createGmailClient(config: { restUrl: string; authToken?: string }) {
  const restUrl = config.restUrl.replace(/\/$/, "");
  return async (path: string, method = "GET", body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body) headers["content-type"] = "application/json";
    if (config.authToken) headers.authorization = `Bearer ${config.authToken}`;
    const res = await fetch(`${restUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text || res.statusText };
    return text ? JSON.parse(text) : null;
  };
}

/**
 * Build the tool table this agent hands the model.
 *
 * Exported and config-taking (rather than closing over module-level env) so a
 * gate can exercise every tool against a live twin without a model — F-1152. The
 * sibling `pr-summary-*` examples shipped a `comment_on_pull_request` the GitHub
 * twin refused on every subject for as long as they existed, and neither older
 * example gate ever reaches a twin call.
 *
 * `sender` is resolved from the live mailbox profile by `main()` and passed in;
 * it falls back to the twin's default mailbox so the table can be built without
 * a round trip.
 */
export function buildTools(config: { restUrl: string; authToken?: string; sender?: string }) {
  const gmail = createGmailClient(config);
  const sender = config.sender ?? DEFAULT_SENDER;

  return {
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
}

async function main() {
  const task = requiredEnv("POME_TASK");
  const restUrl = requiredEnv("POME_GMAIL_REST_URL");
  const authToken = process.env.POME_AUTH_TOKEN ?? process.env.POME_GMAIL_TOKEN;
  const modelSlug = (process.env.GMAIL_AGENT_MODEL ?? "anthropic/claude-opus-4-8").trim();
  const maxSteps = Number(process.env.GMAIL_AGENT_MAX_STEPS ?? 30);

  // F-1519 — positive-evidence marker `scripts/smoke-examples.mjs` classifies
  // REACHED-OUTBOUND on, printed immediately before this example's first
  // outbound call (the Gmail twin's profile lookup, ahead of the model call).
  // This example has no @pome-sh dependency to emit it for free, so it is a
  // literal print, gated so real users never see it.
  if (process.env.POME_SMOKE_MARK_OUTBOUND === "1") console.error("POME_SMOKE_REACHED_OUTBOUND");
  const profile = await createGmailClient({ restUrl, authToken })(`/gmail/v1/users/me/profile`);
  const sender =
    profile && typeof profile === "object" && "emailAddress" in profile
      ? String((profile as { emailAddress: string }).emailAddress)
      : DEFAULT_SENDER;

  const model = await resolveModel(modelSlug);
  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: task,
    tools: buildTools({ restUrl, authToken, sender }),
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

function buildMime({ from, to, subject, body }: { from: string; to: string; subject: string; body: string }): string {
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\r\n",
  );
}

// Plain string replacement rather than regexes. `=` only ever appears as base64
// padding, at the end and at most twice, so stripping every `=` is equivalent to
// anchoring on the tail — and it drops the `/=+$/` that CodeQL flags as a
// polynomial-ReDoS sink (`js/polynomial-redos`). The regex was harmless while
// `buildTools` was module-private; exporting it for the F-1152 probe gate put a
// caller-reachable path in front of it, which is what turned the alert on.
function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

// This block MUST stay at the bottom of the module (F-900): a launch above the
// declarations it uses dies in the temporal dead zone, and `tsc` cannot see it.
// Guarding the launch (rather than calling `main()` at top level) also keeps the
// module importable, which is what lets F-1152's gate probe `buildTools`
// without running the agent.
// NOT `import.meta.main`: that landed in Node 24.2 and this package's `engines`
// allows `>=24`, so on 24.0/24.1 it is `undefined`, this guard is false, and
// `npm start` prints nothing and exits 0 having run no agent at all (F-1481).
// Realpath'd on BOTH sides because node resolves symlinks before deriving
// `import.meta.url`, so a bare `resolve` of argv[1] misses through a symlinked
// checkout (a worktree, macOS's `/tmp`) in the same silent shape.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolvePath(process.argv[1])) : "";

if (ENTRY === SELF) {
  if (process.env.POME_PREFLIGHT === "1") {
    console.log("preflight ok");
  } else {
    await main();
  }
}
