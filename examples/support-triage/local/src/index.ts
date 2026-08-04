/**
 * Pome hero example: support-triage as a LOCAL examinee.
 *
 * A minimal Claude Agent SDK agent that runs on YOUR machine (modeled on
 * ../../triage-agent). It watches for a customer bug report from the
 * `#support` Slack channel, triages it, tracks it as a GitHub issue in
 * acme/orders-service, and posts the tracking link back to `#support` —
 * against Pome's GitHub + Slack twins, over MCP.
 *
 * Launch model: the coach calls the Pome control MCP's `run_task`, which
 * seeds live twin sandboxes and returns an `examinee_launch` spec. The coach
 * then spawns THIS process as a local subprocess with the spec mapped into
 * env (see resolveTwinWiring below), waits for it to exit, and calls
 * `finalize_run` the instant it does. The same env contract is what the Pome
 * CLI injects on `pome run … --agent "npm run start"`, so both launchers
 * share this one code path.
 *
 * The product story lives in ONE line: DENY_ISSUE_LOOKUP below ships as `true`,
 * which strips the agent's read access to existing issues. It searches, as its
 * instructions tell it to, is refused, and honestly concludes nothing tracks the
 * bug — so it files a duplicate and fails the exam. Flip the constant, re-run,
 * and the same exam goes green.
 *
 * `query` comes from `@pome-sh/adapter-claude-sdk` rather than the raw SDK. It
 * is a drop-in — the message stream is byte-for-byte what the SDK yields — and
 * it emits gen_ai OTLP spans (model, per-turn tokens, latency) when a runner
 * injects POME_OTEL_EXPORTER_OTLP_ENDPOINT, which is what puts a real waterfall
 * on this example's report instead of the shallowest trace in the catalog. It is
 * inert with no endpoint set, so a standalone run is unaffected.
 */

import { query } from "@pome-sh/adapter-claude-sdk";

// ─── The one line under test ───────────────────────────────────────────────
//
// Curriculum class 1/dedup, and a PATTERN-1 baseline: the flaw is committed
// CONFIGURATION, not a prompt (`pome-cloud docs/curriculum/failure-classes.md`
// §3). Read the rationale in ../README.md before changing either constant.
//
// The agent's tool policy denies it every read path into the repository's
// issues. It can create one and comment on one; it cannot look one up. So it
// does exactly what its instructions say — search first — is refused, finds
// nothing, and correctly concludes the bug is untracked. It then files a SECOND
// issue for a bug issue #1 already tracks.
//
// WHY IT DOES NOT ROT. The system prompt below is the CORRECT one: it tells the
// agent to search before filing, and a stronger model follows it more reliably,
// not less. That is the whole point — perfect model behaviour is corrupted by
// the committed config, and no amount of capability can call a tool that was
// never exposed. This is what the earlier baseline could not promise: it lived
// in a prompt line telling the agent NOT to search, which is a pattern-2 flaw
// whose red is model-dependent and, worse, indistinguishable from an evaluator
// that never ran.
//
// The three names are the Claude Agent SDK's MCP tool ids — `mcp__<server>__<tool>`,
// where the server is the `github` key of `mcpServers` below. They are the GitHub
// twin's ONLY read paths to an issue; leaving any one of them open lets the agent
// route around the defect and the baseline goes green for the wrong reason.
const ISSUE_LOOKUP_TOOLS = [
  "mcp__github__search_issues",
  "mcp__github__list_issues",
  "mcp__github__get_issue",
];

// ⛔ Ships as `true` — the failing baseline. Set it to `false`; that is the fix.
const DENY_ISSUE_LOOKUP = true;

/**
 * The tools this examinee refuses to expose.
 *
 * Named rather than inlined so `test/tool-policy.test.ts` can pin BOTH branches
 * without asserting which one ships — a guard the documented fix turns red is a
 * guard you edit to make green.
 *
 * `WebSearch`/`WebFetch` are unconditional and are NOT part of the lesson: the
 * seeded twin world is the whole exam, so an agent that can reach the open web
 * is taking a different test.
 */
export function deniedTools(denyIssueLookup: boolean = DENY_ISSUE_LOOKUP): string[] {
  return ["WebSearch", "WebFetch", ...(denyIssueLookup ? ISSUE_LOOKUP_TOOLS : [])];
}
// ───────────────────────────────────────────────────────────────────────────

// The CORRECT triage rule, in both variants. It is verbatim
// ../../agents/support-triage-v2.yaml's line, and it stays put: under a
// pattern-1 baseline the prompt is not what is broken.
const TRIAGE_RULE =
  "Your first action for any report is ALWAYS to search the open issues in acme/orders-service before doing anything else; only if no existing issue already tracks the bug may you open a new one — if one does, comment on that existing issue and post ITS link back, never opening a second issue for a bug that is already tracked.";

const SYSTEM_PROMPT = `You are a support-triage agent for the acme engineering org.

Your job: watch the #support Slack channel for bug reports, reproduce and
triage them, track each bug as a GitHub issue in acme/orders-service with the
"bug" label, and post the tracking issue link back to #support so the reporter
can follow along.

${TRIAGE_RULE}

Be concise. Include real reproduction steps.`;

// Fallback kickoff prompt when the launcher doesn't inject POME_TASK. Matches
// the `## Prompt` of ../../tasks/duplicate-issue.md (the task itself —
// seed, criteria, config — stays in that file; this is only the kickoff line).
const DEFAULT_TASK = `A customer bug report came in on the #support Slack channel. Triage it: reproduce the problem, file a GitHub issue in acme/orders-service with repro steps and the "bug" label, and post the issue link back to the #support thread.`;

export interface TwinWiring {
  githubMcpUrl: string;
  slackMcpUrl: string;
  authToken: string;
  task: string;
}

/** Read the twin wiring from env — the platform convention both launchers
 * speak (the coach maps `run_task`'s `examinee_launch` onto it; the Pome CLI
 * injects it on `pome run`):
 *
 *   POME_GITHUB_MCP_URL  per-session GitHub twin MCP endpoint
 *   POME_SLACK_MCP_URL   per-session Slack twin MCP endpoint
 *   POME_AUTH_TOKEN      session bearer JWT — the Authorization header for BOTH
 *   POME_TASK            kickoff prompt (optional; bundled fallback below)
 *
 * Auth is env-only: the examinee never probes on-disk twin state, and the
 * bearer lives in memory for this run only. Fails loudly naming every missing
 * var so a mis-assembled launch dies in preflight, not mid-run. */
export function resolveTwinWiring(env: NodeJS.ProcessEnv = process.env): TwinWiring {
  const githubMcpUrl = env.POME_GITHUB_MCP_URL;
  const slackMcpUrl = env.POME_SLACK_MCP_URL;
  const authToken = env.POME_AUTH_TOKEN;
  const missing = [
    ...(githubMcpUrl ? [] : ["POME_GITHUB_MCP_URL"]),
    ...(slackMcpUrl ? [] : ["POME_SLACK_MCP_URL"]),
    ...(authToken ? [] : ["POME_AUTH_TOKEN"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Missing twin wiring in the environment: ${missing.join(", ")}.\n` +
        "This examinee is launched by a Pome runner, which injects the twin\n" +
        "MCP URLs and the session bearer:\n" +
        "  • coach flow — `run_task` returns an `examinee_launch` spec; map its\n" +
        "    per-twin MCP URLs to POME_GITHUB_MCP_URL / POME_SLACK_MCP_URL and\n" +
        "    its agent_token to POME_AUTH_TOKEN, then spawn `npm run start`.\n" +
        "  • CLI flow — `pome run ../tasks/duplicate-issue.md --agent \"npm run start\"`\n" +
        "    injects all of them automatically."
    );
  }
  return {
    githubMcpUrl: githubMcpUrl!,
    slackMcpUrl: slackMcpUrl!,
    authToken: authToken!,
    task: env.POME_TASK?.trim() || DEFAULT_TASK,
  };
}

// Only run the agent when executed directly (`npm run start`). Guarding on
// `import.meta.main` keeps the module importable — e.g. by the env unit test —
// without kicking off a full agent run on import.
if (import.meta.main) {
  await main();
}

async function main() {
  const wiring = resolveTwinWiring();

  if (process.env.POME_PREFLIGHT === "1") {
    // Pome CLI's preflight: a 10s sanity boot before the real run. Verify both
    // twins are reachable with the bearer, then exit 0 so the real run can
    // start. Failing here surfaces config bugs before burning a full run.
    await preflight(wiring);
    return;
  }

  banner(wiring);

  // Both twins are plain streamable-HTTP MCP servers; the session bearer is
  // the Authorization header on every call. No wrapper code — the Agent SDK's
  // MCP client speaks to the twins exactly as it would to the real services.
  const mcpServers = {
    github: {
      type: "http" as const,
      url: wiring.githubMcpUrl,
      headers: { Authorization: `Bearer ${wiring.authToken}` },
    },
    slack: {
      type: "http" as const,
      url: wiring.slackMcpUrl,
      headers: { Authorization: `Bearer ${wiring.authToken}` },
    },
  };

  const run = query({
    prompt: wiring.task,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      maxTurns: 30,
      // Everything the two twins expose, minus `deniedTools()` — which is where
      // the committed baseline defect lives. See the block at the top of this
      // file; `WebSearch`/`WebFetch` are the unconditional closed-book clamp and
      // are not part of the lesson.
      disallowedTools: deniedTools(),
      mcpServers,
    },
  });

  let exitCode = 0;
  for await (const msg of run) {
    if (msg.type === "assistant") {
      logAssistantMessage(msg);
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        console.log("\n— agent finished —");
        if (msg.result) console.log(msg.result);
        console.log(
          `(${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out, $${msg.total_cost_usd.toFixed(4)})`
        );
      } else {
        console.error(`\nagent stopped: ${msg.subtype}`);
        for (const err of msg.errors) console.error(err);
        exitCode = 1;
      }
    }
  }

  // Exit explicitly once the run result has been consumed: done means done —
  // the launcher watches this process and calls `finalize_run` on exit.
  process.exit(exitCode);
}

async function preflight(wiring: TwinWiring): Promise<void> {
  // Claude auth: the Agent SDK takes an API key (ANTHROPIC_API_KEY), a
  // subscription token (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`),
  // or a `claude` login stored on this machine — that last one is invisible
  // to env, so hard-failing here would block subscription users whose runs
  // would succeed. Warn with both options instead of throwing.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      "warning: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set — continuing, assuming a stored `claude` subscription login. " +
        "If the run fails on auth: export ANTHROPIC_API_KEY=sk-ant-… (API key) or CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`)."
    );
  }

  // Sanity-check the bearer against each twin's session-scoped MCP surface.
  for (const [twin, url] of [
    ["github", wiring.githubMcpUrl],
    ["slack", wiring.slackMcpUrl],
  ] as const) {
    const probe = await fetch(`${trimSlash(url)}/tools`, {
      headers: { authorization: `Bearer ${wiring.authToken}` },
    }).catch((err) => {
      throw new Error(
        `${twin} twin MCP not reachable at ${url}/tools: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    if (!probe.ok) throw new Error(`${twin} twin MCP probe failed: ${probe.status}`);
  }

  console.log("preflight ok");
}

function banner(wiring: TwinWiring) {
  console.log("─".repeat(72));
  console.log("Pome support-triage examinee (local)");
  console.log(`github twin MCP: ${wiring.githubMcpUrl}`);
  console.log(`slack twin MCP:  ${wiring.slackMcpUrl}`);
  console.log("task:");
  for (const line of wiring.task.split("\n")) console.log(`  ${line}`);
  console.log("─".repeat(72));
}

function logAssistantMessage(msg: { message: { content?: Array<unknown> } }) {
  for (const block of msg.message.content ?? []) {
    const b = block as { type: string; text?: string; name?: string; input?: unknown };
    if (b.type === "text" && b.text) {
      console.log(`assistant: ${b.text}`);
    } else if (b.type === "tool_use") {
      const args = JSON.stringify(b.input);
      console.log(`tool_use:  ${b.name}(${args.length > 200 ? `${args.slice(0, 197)}...` : args})`);
    }
  }
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
