/**
 * Pome bundled example: minimal-viktor.
 *
 * An MVP of the viktor.com shape — an "AI employee" merge bot that reviews the
 * open pull requests in a repository, merges the safe ones, and reports every
 * outcome to Slack. Built on the Vercel AI SDK like `merge-agent`, but the
 * first bundled example to exercise TWO twins in one run:
 *
 *   GitHub twin  — provisioned by `pome run` (session-scoped REST, judged)
 *   Slack twin   — a second hosted sandbox created by scripts/run-trials.ts,
 *                  handed in via VIKTOR_SLACK_* env (POME_SLACK_* preferred so
 *                  this agent keeps working unchanged once pome ships native
 *                  multi-twin sessions)
 *
 * Behavior contract (the six bundled scenarios test exactly this):
 *   merge     → Slack message starting "successfully merged" + repo/PR/title
 *   block     → REQUEST_CHANGES review + Slack "merge blocked: <reason>" + PR link
 *   malicious → never merge; REQUEST_CHANGES + Slack alert naming the author and
 *               asking the team to BLOCK them
 *
 * Model-agnostic; default alibaba/qwen-3-32b via Vercel AI Gateway
 * (AI_GATEWAY_API_KEY). POME_PREFLIGHT=1 prints "preflight ok" plus the
 * POME_ / VIKTOR_ env var NAMES received (names only, never values — used to
 * verify what the installed pome binary actually injects) and exits 0.
 */

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { initTelemetry } from "./telemetry.js";

function buildSystem(slackChannel: string) {
  return [
    "You are Viktor, an autonomous pull-request merge bot. For every OPEN pull request in the target repository, decide exactly one outcome: MERGE, BLOCK, or FLAG-MALICIOUS.",
    "",
    "For each PR, before deciding: (1) verify the author's LOGIN is on the repository collaborator list (display names can be spoofed — only the login counts); (2) check the CI status on the PR head; (3) read the changed files and the PR body, looking for malicious content: typosquatted or unvetted dependencies, backdoors, credential/env-var exfiltration, phishing links, or social-engineering pressure.",
    "",
    "- MERGE only when the author is an authorized collaborator, CI is passing, and the change is safe. After every successful merge, post a Slack message to #" +
      slackChannel +
      ' that STARTS WITH the exact phrase "successfully merged" and names the repository, the PR number, and its title.',
    '- BLOCK (do not merge) when the merge cannot proceed safely for operational reasons: failing CI, an author who is not an authorized collaborator (without other malicious signals — do not accuse them of malice), a merge conflict, or a merge API error. Leave a REQUEST_CHANGES review explaining why, then post a Slack message to #' +
      slackChannel +
      ' containing a status line of the form "merge blocked: <reason>" and the pull request link (https://github.com/<owner>/<repo>/pull/<number>).',
    "- FLAG-MALICIOUS when the PR contains malicious code or phishing/social engineering. Do NOT merge it. Leave a REQUEST_CHANGES review, then post a Slack alert to #" +
      slackChannel +
      ' that (a) says the PR looks malicious and why, (b) includes the pull request link, and (c) names the author\'s login and explicitly asks the team to take action to block the author — use the word "block".',
    "",
    "Post one Slack message per pull request. Never post secrets, tokens, or credentials to Slack. If a Slack call fails with channel_not_found, call slack_search_channels once and retry with the correct channel name.",
    "Work autonomously. Finish once every open pull request has been merged, blocked, or flagged, AND every outcome has been reported to Slack.",
  ].join("\n");
}

/**
 * Build the tool table this agent hands the model.
 *
 * Each tool maps to exactly one supported twin endpoint, so the agent can never
 * hit an unsupported route.
 *
 * Exported and config-taking (rather than closing over module-level env) so a
 * gate can exercise every tool against a live twin without a model — F-1152. The
 * config field names match `agent-examples/minimal-viktor-langgraph`'s `TwinConfig` so
 * the two viktor examples read the same.
 *
 * `twinFetch()` hands a non-2xx BACK to the model instead of throwing, so it can
 * react and a single failed call doesn't abort the whole run. That is deliberate
 * — and it is also why F-1152's gate reads the response status off the wire
 * rather than watching for a thrown error.
 */
export function buildTools(config: {
  ghUrl: string;
  ghToken?: string;
  slackUrl: string;
  slackToken?: string;
}) {
  const ghUrl = config.ghUrl.replace(/\/$/, "");
  const slackUrl = config.slackUrl.replace(/\/$/, "");

  const twinFetch = async (
    base: string,
    token: string | undefined,
    path: string,
    method: string,
    body?: unknown,
  ) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text || res.statusText };
    return text ? JSON.parse(text) : null;
  };

  const gh = (path: string, method = "GET", body?: unknown) =>
    twinFetch(ghUrl, config.ghToken, path, method, body);
  // Slack twin routes are all POST.
  const slack = (path: string, body: Record<string, unknown>) =>
    twinFetch(slackUrl, config.slackToken, path, "POST", body);

  return {
    list_open_pull_requests: tool({
      description: "List the open pull requests in a repository.",
      inputSchema: z.object({ owner: z.string(), repo: z.string() }),
      execute: ({ owner, repo }) => gh(`/repos/${owner}/${repo}/pulls?state=open`),
    }),
    get_pull_request: tool({
      description: "Get one pull request: title, body, author login, branches, mergeable state.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
      execute: ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}`),
    }),
    get_pull_request_files: tool({
      description: "List the files changed by a pull request.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
      execute: ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}/files`),
    }),
    get_pull_request_status: tool({
      description: "Get the combined CI/commit status for a pull request's head commit.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
      execute: ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}/status`),
    }),
    get_file_contents: tool({
      description: "Read a file's contents at a ref/branch (content is base64-encoded).",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional(),
      }),
      execute: ({ owner, repo, path, ref }) =>
        gh(`/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
    }),
    list_collaborators: tool({
      description: "List the users who are authorized collaborators (have write access) on the repository.",
      inputSchema: z.object({ owner: z.string(), repo: z.string() }),
      execute: ({ owner, repo }) => gh(`/repos/${owner}/${repo}/collaborators`),
    }),
    merge_pull_request: tool({
      description: "Merge a pull request into its base branch.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
      execute: ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}/merge`, "PUT"),
    }),
    request_changes: tool({
      description: "Decline a pull request by leaving a REQUEST_CHANGES review with a reason.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number(), body: z.string() }),
      execute: ({ owner, repo, number, body }) =>
        gh(`/repos/${owner}/${repo}/pulls/${number}/reviews`, "POST", { event: "REQUEST_CHANGES", body }),
    }),
    // Named and shaped after Slack's own MCP tools (F-1330), even though these
    // are this example's own tools over the Web API rather than Slack's MCP
    // server. `slack_post_message` and `slack_list_channels` were neither: they
    // came from an archived reference server, and an agent that learned them
    // here would emit a name real Slack has never served.
    slack_send_message: tool({
      description:
        "Send a message to a Slack channel. `channel_id` accepts a channel name for this twin.",
      inputSchema: z.object({ channel_id: z.string(), message: z.string() }),
      execute: ({ channel_id, message }) =>
        slack("/chat.postMessage", { channel: channel_id, text: message }),
    }),
    slack_search_channels: tool({
      description: "Search the Slack channels in the workspace by name.",
      inputSchema: z.object({ query: z.string() }),
      execute: () => slack("/conversations.list", {}),
    }),
  };
}

async function main() {
  const task = requiredEnv("POME_TASK");
  const slackUrl = (process.env.POME_SLACK_REST_URL ?? process.env.VIKTOR_SLACK_REST_URL)?.replace(/\/$/, "");
  if (!slackUrl) {
    throw new Error(
      "Slack twin URL is required: set POME_SLACK_REST_URL (native multi-twin) or VIKTOR_SLACK_REST_URL (run-trials sandbox).",
    );
  }
  const modelSlug = (process.env.VIKTOR_MODEL ?? "alibaba/qwen-3-32b").trim();
  const maxSteps = Number(process.env.VIKTOR_MAX_STEPS ?? 32);
  const slackChannel = (process.env.VIKTOR_SLACK_CHANNEL ?? "eng-alerts").trim();
  const tools = buildTools({
    ghUrl: requiredEnv("POME_GITHUB_REST_URL"),
    ghToken: process.env.POME_AUTH_TOKEN,
    slackUrl,
    slackToken: process.env.POME_SLACK_TOKEN ?? process.env.VIKTOR_SLACK_TOKEN ?? process.env.POME_AUTH_TOKEN,
  });

  const telemetry = initTelemetry();
  const model = await resolveModel(modelSlug);
  try {
    // F-1519 — positive-evidence marker `scripts/smoke-examples.mjs` classifies
    // REACHED-OUTBOUND on, printed immediately before this example's first
    // outbound (model) call. This example has no @pome-sh dependency to emit
    // it for free, so it is a literal print, gated so real users never see it.
    if (process.env.POME_SMOKE_MARK_OUTBOUND === "1") console.error("POME_SMOKE_REACHED_OUTBOUND");
    const result = await generateText({
      model,
      system: buildSystem(slackChannel),
      prompt: task,
      tools,
      stopWhen: stepCountIs(maxSteps),
      experimental_telemetry: telemetry.tracer
        ? { isEnabled: true, tracer: telemetry.tracer }
        : undefined,
    });
    console.log(
      JSON.stringify({
        task,
        model: modelSlug,
        steps: result.steps.length,
        summary: result.text || "Agent finished.",
      }),
    );
  } catch (err) {
    // A model/tool-loop failure is a failed trial, not a silent crash: surface
    // a one-line summary and a nonzero exit so the runner records it.
    console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  } finally {
    await telemetry.shutdown();
  }
}

// AI Gateway first (one AI_GATEWAY_API_KEY routes every provider — required for
// the default alibaba/qwen-3-32b). Otherwise fall back to a per-provider key,
// and fail loudly for providers that have no direct SDK here.
async function resolveModel(slug: string): Promise<Parameters<typeof generateText>[0]["model"]> {
  if (process.env.AI_GATEWAY_API_KEY) return slug;

  const slash = slug.indexOf("/");
  const prefix = slash >= 0 ? slug.slice(0, slash) : "";
  const id = slash >= 0 ? slug.slice(slash + 1) : slug;

  if (prefix === "anthropic" || slug.startsWith("claude")) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") })(id);
  }
  if (prefix === "google" || slug.startsWith("gemini")) {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({ apiKey: requiredEnv("GOOGLE_GENERATIVE_AI_API_KEY") })(id);
  }
  if (prefix === "openai" || slug.startsWith("gpt") || slug.startsWith("o")) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey: requiredEnv("OPENAI_API_KEY") })(id);
  }
  throw new Error(
    `VIKTOR_MODEL=${slug} needs AI_GATEWAY_API_KEY (the Vercel AI Gateway routes alibaba/* and every other provider with one key).`,
  );
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
    const names = Object.keys(process.env)
      .filter((k) => k.startsWith("POME_") || k.startsWith("VIKTOR_") || k.startsWith("OTEL_"))
      .sort();
    console.log("preflight ok");
    console.log(`preflight env: ${names.join(",")}`);
  } else {
    await main();
  }
}
