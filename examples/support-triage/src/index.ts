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
 * ⚠️ THE BASELINE BELOW IS NOT RED. Measured 2026-08-04 on `claude-opus-5`,
 * n=5, hosted: `DENY_ISSUE_LOOKUP = true` scored 25 · 100 · 100 · 100 · 100 and
 * no trial filed a duplicate. The re-cut is [F-1292]; ../VERIFICATION.md carries
 * the run ids and the two routes the agent found around the denial. Do not
 * describe this file's defect as a working lesson until that ticket closes.
 *
 * `query` comes from `@pome-sh/adapter-claude-sdk` rather than the raw SDK. It
 * is a drop-in — the message stream is byte-for-byte what the SDK yields — and
 * it emits gen_ai OTLP spans (model, per-turn tokens, latency) when a runner
 * injects POME_OTEL_EXPORTER_OTLP_ENDPOINT, which is what puts a real waterfall
 * on this example's report instead of the shallowest trace in the catalog. It is
 * inert with no endpoint set, so a standalone run is unaffected.
 */

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
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
// IT DID ROT, AND HERE IS THE MEASUREMENT. This block used to claim the baseline
// could not go green because "no amount of capability can call a tool that was
// never exposed". That is true and beside the point: the model never needed the
// denied tool. Measured on `claude-opus-5`, n=5 each:
//
//   open sandbox    4/5 green — via `update_issue` (a write that 404s on a
//                   missing issue) and via the SDK's shell reading this file
//   closed sandbox  5/5 green — the shell gone changed nothing. All five trials
//                   used `list_issue_comments` AND `update_issue`, neither of
//                   which is named below, and `search_code` for the root cause.
//
// Two more read paths turned up the moment the first three were shut. A denial
// is only as strong as the enumeration behind it, and this one is not complete
// — see ../VERIFICATION.md. Completing it is not the fix; F-1292 moves the flaw.
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

/**
 * The SDK built-ins this examinee exposes to the model: **none**.
 *
 * This is the closed sandbox, and it is deliberately an ALLOWLIST rather than an
 * addition to `deniedTools()`. `options.tools` replaces the base set of built-in
 * tools, so an empty array is complete by construction — there is no list of
 * names to keep current, and no way for a tool nobody thought of to arrive
 * enabled. That is the failure mode the deny-list above already had (F-1292):
 * every built-in was live, so `cat tasks/duplicate-issue.md` handed the
 * examinee all four grading criteria and the complete seed; `Bash` reached the
 * real internet, since the `network.mode: limited` clamp binds a managed clone's
 * egress and never a local subprocess; and one measured trial read this very
 * file and reported the deny-list as an intentional fixture.
 *
 * MCP tools are unaffected — they arrive from `mcpServers`, not from the
 * built-in set — so the twin surface the exam is actually about stays whole.
 * Verified live rather than from the docs: with `tools: []` the SDK's `init`
 * message listed 100 tools, all `mcp__*`, and the run scored 100 on all four
 * criteria (see ../VERIFICATION.md, `grp_f1292honest0805`).
 *
 * `allowedTools` is NOT a substitute. It only auto-approves; it does not
 * restrict. Measured 2026-08-05: `allowedTools: ["mcp__github-twin__list_issues"]`
 * left 152 tools live including `Bash`, `Read`, `Write` and `WebFetch`.
 */
export const BUILT_IN_TOOLS: string[] = [];

/**
 * The options this examinee actually runs with — the exam surface, composed in
 * one place.
 *
 * A `function` declaration rather than a `const` arrow: this file's top-level
 * `await main()` sits above it, and a `const` here would be a temporal dead zone
 * at call time (the `scripts/smoke-examples.mjs` gate exists because exactly
 * that crash once shipped in `examples/triage-agent`).
 *
 * Exported so `test/tool-policy.test.ts` can assert the two policy constants are
 * WIRED IN, not merely declared. Asserting `BUILT_IN_TOOLS` is empty proves
 * nothing on its own: delete `tools:` from this object and that assertion stays
 * green while the sandbox reopens. A guard whose subject is no longer connected
 * to anything passes forever, which is the same shape of mistake F-1292 is about.
 */
export function examineeOptions(mcpServers: Record<string, McpServerConfig>) {
  return {
    systemPrompt: SYSTEM_PROMPT,
    permissionMode: "bypassPermissions" as const,
    maxTurns: 30,
    // The exam surface: the two twins over MCP, and nothing else. `tools` is the
    // allowlist that closes the sandbox (empty = no SDK built-in reaches the
    // model); `disallowedTools` is where the committed baseline defect lives.
    // Its `WebSearch`/`WebFetch` entries are now a redundant second latch —
    // `tools: []` already removed them — and are kept because the two options
    // are independent knobs and the web clamp should not depend on which one a
    // future SDK version reinterprets.
    tools: BUILT_IN_TOOLS,
    // A DIFFERENT door from `tools`, and shutting one says nothing about the
    // other. `tools` governs the SDK's built-in base set; `settingSources`
    // governs FILESYSTEM settings — user (~/.claude/settings.json), project
    // (.claude/settings.json) and local (.claude/settings.local.json) —
    // INCLUDING the Claude Code plugin MCP servers configured on whoever's
    // machine this runs on. The SDK loads all three when the option is omitted
    // ("matches CLI defaults"); `[]` is its documented isolation mode.
    //
    // Measured 2026-08-05 (F-1295), on a `claude-haiku-4-5` trial of this very
    // task with `tools: []` ALREADY SET: the examinee called
    // `mcp__plugin_slack_slack__slack_search_channels`, `…__slack_search_public`
    // and `…__slack_list_channel_members` — it searched the DEVELOPER's real
    // Slack workspace, made zero twin calls, and would have scored as "the agent
    // failed to triage". A verdict about the wrong workspace entirely. With this
    // line the same trial called only `mcp__github__*` / `mcp__slack__*`,
    // searched issues first, commented on #1, posted the link, and scored 75.
    //
    // Local, and therefore inherited from a machine nobody controls: this is the
    // one exam surface that changes depending on who runs it. `scripts/check-example-sdk-isolation.mjs`
    // is what stops it being deleted along with the comment that explains it.
    settingSources: [],
    disallowedTools: deniedTools(),
    mcpServers,
  };
}
// ───────────────────────────────────────────────────────────────────────────

// The CORRECT triage rule, in both variants. It is verbatim
// ../agents/support-triage-v2.yaml's line, and it stays put: under a
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
// the `## Prompt` of ../tasks/duplicate-issue.md (the task itself —
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
        "  • CLI flow — `pome run tasks/duplicate-issue.md --agent \"npm run start\"`\n" +
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

// Only run the agent when executed directly (`npm start`), so the module stays
// importable — e.g. by the env unit test — without kicking off a full agent run.
//
// NOT `import.meta.main`: that landed in Node 24.2 and this package's `engines`
// allows `>=24`, so on 24.0/24.1 it is `undefined`, this guard is false, and
// `npm start` prints nothing and exits 0 having run no agent at all. That is
// worse than a crash here: `scripts/smoke-examples.mjs` — the gate that covers
// this example — only fails on a TDZ ReferenceError, so it reads a do-nothing
// exit 0 as a healthy launch and reports OK. The argv/`import.meta.url`
// comparison the repo's other entry guards use (`contract/run.mjs`,
// `scripts/check-packages-scripts-wired.mjs`), realpath'd on BOTH sides because
// node resolves symlinks before deriving `import.meta.url`, so a bare
// `path.resolve` of argv[1] misses through a symlinked checkout in the same
// silent shape.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolvePath(process.argv[1])) : "";

if (ENTRY === SELF) {
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

  // F-1519 — positive-evidence marker `scripts/smoke-examples.mjs` classifies
  // REACHED-OUTBOUND on, printed immediately before this example's first
  // outbound (model) call. This example pins the PUBLISHED
  // `@pome-sh/adapter-claude-sdk` (it must stay `npx degit`-fetchable
  // standalone), so the workspace `query()`'s own marker is NOT in the tarball
  // it installs — the literal has to be here. Gated so real users never see it.
  if (process.env.POME_SMOKE_MARK_OUTBOUND === "1") console.error("POME_SMOKE_REACHED_OUTBOUND");
  const run = query({ prompt: wiring.task, options: examineeOptions(mcpServers) });

  let exitCode = 0;
  try {
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
  } catch (err) {
    // F-1518: the Claude Agent SDK's message iterator can REJECT — not just
    // yield an error `result` message — when the underlying `claude` CLI exits
    // non-zero (an invalid API key is one way; the SDK calls
    // `inputStream.error()` on the stream being iterated). Uncaught, that threw
    // out of this `for await` and killed the process with a raw Node stack
    // instead of this example's own reporting, so route it through the same
    // exitCode=1 path the graceful branch uses.
    //
    // Log the error OBJECT, never just `err.message`: Node prints name + stack
    // + `[cause]`, and scripts/smoke-examples.mjs classifies this output by
    // matching signatures that can live OUTSIDE the message — `AbortError` and
    // `AI_LoadAPIKeyError` are error NAMES, and undici reports
    // `ECONNREFUSED`/`ENOTFOUND` only on `err.cause`. Logging the message alone
    // would show the classifier strictly less than the uncaught rejection did,
    // turning a benign outbound abort into "no evidence it did any real work" —
    // trading one nondeterministic red for another.
    console.error("\nagent errored:", err);
    exitCode = 1;
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
