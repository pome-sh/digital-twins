#!/usr/bin/env node
/**
 * Regression coverage for scripts/probe-example-tools.mjs (F-1152).
 *
 * The gate exists because `comment_on_pull_request` in
 * examples/pr-summary-agent and examples/pr-summary-review wrapped
 * `add_issue_comment` at a pull request's number, the GitHub twin answered
 * `404 Issue not found` for every one of those calls on all four subjects for
 * as long as the examples had existed, and both older example gates
 * (typecheck:examples, smoke:examples) were green throughout. The cases below
 * are written from that incident.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotateFromTape,
  evaluateProbeRun,
  formatFindings,
  freePort,
  PROBE_SECRET,
  resolveConfig,
  splitSeed,
  withSharedTypesRuntime,
} from "./probe-example-tools.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}
function assertThrows(fn, match, msg) {
  try {
    fn();
  } catch (err) {
    assert(String(err.message).includes(match), `${msg} (message was: ${err.message})`);
    return;
  }
  assert(false, `${msg} (did not throw)`);
}

// ── splitSeed ───────────────────────────────────────────────────────────────
// Mirrors cli/src/task/parseTask.ts. Envelope-iff-multi-twin, decided from the
// declared twin list alone — never by sniffing the seed shape.
//
// A single-twin example ships a FLAT seed. examples/triage-agent's is
// { _meta, users, repositories }.
{
  const flat = { _meta: { version: 1 }, users: [], repositories: [{ owner: "acme", name: "api" }] };
  const out = splitSeed(flat, ["github"]);
  assert(out.github.repositories === flat.repositories, "splitSeed hands a flat seed to the single declared twin");
  // Not politeness: the gmail twin's seed schema is strict and rejects `_meta`.
  assert(!("_meta" in out.github), "splitSeed strips the _meta envelope before the twin's schema sees it");
}

// A multi-twin example ships a PER-TWIN ENVELOPE. Both viktor examples'
// 01-clean-merge.seed.json is exactly { github: {...}, slack: {...} }.
{
  const gh = { _meta: { version: 1 }, users: [], repositories: [] };
  const sl = { channels: [] };
  const out = splitSeed({ github: gh, slack: sl }, ["github", "slack"]);
  assert(out.github.repositories === gh.repositories, "splitSeed slices the github half of an envelope");
  assert(!("_meta" in out.github), "splitSeed strips _meta from an envelope slice too");
  assert(out.slack.channels === sl.channels, "splitSeed slices the slack half of an envelope");
}

// Envelope keys are a SUBSET of the declared twins: a twin with no key falls
// back to its own default world, which `serve()` reads as `seed: undefined`.
{
  const out = splitSeed({ github: { repositories: [] } }, ["github", "slack"]);
  assert(out.slack === undefined, "a declared twin absent from the envelope falls back to its default seed");
}

// A key that is not a declared twin is a loud error.
assertThrows(
  () => splitSeed({ github: {}, slack: {} }, ["github", "gmail"]),
  "slack",
  "splitSeed rejects an envelope key the example does not declare",
);

// ── resolveConfig ───────────────────────────────────────────────────────────
{
  const ctx = {
    twins: {
      github: { rest: "http://127.0.0.1:5001", mcp: "http://127.0.0.1:5001/s/probe/mcp" },
      slack: { rest: "http://127.0.0.1:5002", mcp: "http://127.0.0.1:5002/s/probe/mcp" },
    },
    token: "jwt-abc",
  };
  const out = resolveConfig(
    { mcpUrl: "$github.mcp", ghUrl: "$github.rest", slackUrl: "$slack.rest", token: "$token" },
    ctx,
  );
  assert(out.mcpUrl === "http://127.0.0.1:5001/s/probe/mcp", "resolveConfig fills $<twin>.mcp");
  assert(out.ghUrl === "http://127.0.0.1:5001", "resolveConfig fills $<twin>.rest");
  assert(out.slackUrl === "http://127.0.0.1:5002", "resolveConfig fills a second twin");
  assert(out.token === "jwt-abc", "resolveConfig fills $token");

  const literal = resolveConfig({ channel: "eng-alerts", max: 3 }, ctx);
  assert(literal.channel === "eng-alerts" && literal.max === 3, "resolveConfig passes non-$ values through");

  assertThrows(
    () => resolveConfig({ url: "$stripe.rest" }, ctx),
    "$stripe.rest",
    "resolveConfig rejects a token naming a twin that was not booted",
  );
  assertThrows(
    () => resolveConfig({ url: "$github.graphql" }, ctx),
    "$github.graphql",
    "resolveConfig rejects an unknown surface on a booted twin",
  );
}

// ── evaluateProbeRun: the five ways the gate goes red ───────────────────────
const SEED = "tasks/01-summarize-prs.seed.json";
function ok(tool) {
  return { tool, calls: [{ method: "POST", url: "http://t/s/probe/mcp/call", status: 200 }], threw: null };
}
function run(overrides = {}) {
  return evaluateProbeRun({
    example: "pr-summary-agent",
    seed: SEED,
    probes: [{ tool: "list_open_pull_requests", args: { owner: "acme", repo: "widgets" } }],
    report: { toolNames: ["list_open_pull_requests"], probes: [ok("list_open_pull_requests")], error: null },
    ...overrides,
  });
}

assert(run().length === 0, "evaluateProbeRun is silent on a clean run");

// 1. refused — THE incident. comment_on_pull_request wrapped add_issue_comment
// at a PR number and the twin answered 404 for every subject.
{
  const findings = evaluateProbeRun({
    example: "pr-summary-agent",
    seed: SEED,
    probes: [
      { tool: "comment_on_pull_request", args: { owner: "acme", repo: "widgets", pull_number: 1, body: "probe" } },
    ],
    report: {
      toolNames: ["comment_on_pull_request"],
      probes: [
        {
          tool: "comment_on_pull_request",
          calls: [{ method: "POST", url: "http://t/s/probe/mcp/call", status: 404 }],
          threw: "twin tool add_issue_comment failed: 404 Issue not found",
        },
      ],
      error: null,
    },
  });
  assert(findings.length === 1 && findings[0].kind === "refused", "a 4xx twin answer is a `refused` finding");
  assert(findings[0].tool === "comment_on_pull_request", "the finding names the example's tool, not the twin action");
}

// A 5xx counts too — the gate's claim is "the twin did not refuse", not "not 4xx".
assert(
  run({
    report: {
      toolNames: ["list_open_pull_requests"],
      probes: [
        { tool: "list_open_pull_requests", calls: [{ method: "POST", url: "http://t/x", status: 500 }], threw: null },
      ],
      error: null,
    },
  })[0].kind === "refused",
  "a 5xx twin answer is also `refused`",
);

// A swallowed 4xx is still caught: the AI-SDK and LangGraph examples' gh() hands
// the model {ok:false,status} instead of throwing, so `threw: null` proves
// nothing and only the wire status counts.
assert(
  run({
    report: {
      toolNames: ["list_open_pull_requests"],
      probes: [
        {
          tool: "list_open_pull_requests",
          calls: [{ method: "GET", url: "http://t/repos/acme/widgets/pulls", status: 404 }],
          threw: null,
        },
      ],
      error: null,
    },
  })[0].kind === "refused",
  "a 4xx the example swallowed is still `refused`",
);

// 2. unprobed-tool — the anti-drift clause. A tool with no probe is a hole.
{
  const findings = run({
    report: {
      toolNames: ["list_open_pull_requests", "comment_on_pull_request"],
      probes: [ok("list_open_pull_requests")],
      error: null,
    },
  });
  assert(findings.length === 1 && findings[0].kind === "unprobed-tool", "a registered tool with no probe is a finding");
  assert(findings[0].tool === "comment_on_pull_request", "the unprobed-tool finding names the tool");
}

// 3. unknown-tool — a probe naming a tool the example does not register.
{
  const findings = evaluateProbeRun({
    example: "pr-summary-agent",
    seed: SEED,
    probes: [{ tool: "post_summary", args: {} }],
    report: { toolNames: ["comment_on_pull_request"], probes: [], error: null },
  });
  assert(
    findings.some((f) => f.kind === "unknown-tool" && f.tool === "post_summary"),
    "a probe for an absent tool is a finding",
  );
}

// 4. stale-expect — the escape hatch expires loudly. Without this an F-1151-style
// twin fix leaves a permanent exemption behind.
{
  const probes = [
    {
      tool: "send_email",
      args: {},
      expect_status: 429,
      why: "the seed injects a rate-limit fault on messages.send",
    },
  ];
  const refused = {
    toolNames: ["send_email"],
    probes: [{ tool: "send_email", calls: [{ method: "POST", url: "http://t/x", status: 429 }], threw: null }],
    error: null,
  };
  assert(
    evaluateProbeRun({
      example: "gmail-retry-notify",
      seed: "tasks/01-throttled-send.seed.json",
      probes,
      report: refused,
    }).length === 0,
    "a declared expect_status excuses that exact status",
  );
  const nowGreen = { toolNames: ["send_email"], probes: [ok("send_email")], error: null };
  const findings = evaluateProbeRun({
    example: "gmail-retry-notify",
    seed: "tasks/01-throttled-send.seed.json",
    probes,
    report: nowGreen,
  });
  assert(findings.length === 1 && findings[0].kind === "stale-expect", "an expect_status that no longer happens is a finding");
}

// 5. driver-error — the example failed to import, or the driver died.
{
  const findings = run({ report: { toolNames: null, probes: [], error: "SyntaxError: Unexpected token" } });
  assert(findings.length === 1 && findings[0].kind === "driver-error", "a driver error is a finding");
}

// ── the report has to be readable without re-deriving anything ───────────────
{
  const findings = annotateFromTape(
    evaluateProbeRun({
      example: "pr-summary-agent",
      seed: SEED,
      probes: [
        { tool: "comment_on_pull_request", args: { owner: "acme", repo: "widgets", pull_number: 1, body: "probe" } },
      ],
      report: {
        toolNames: ["comment_on_pull_request"],
        probes: [
          {
            tool: "comment_on_pull_request",
            calls: [{ method: "POST", url: "http://t/s/probe/mcp/call", status: 404 }],
            threw: null,
          },
        ],
        error: null,
      },
    }),
    [
      {
        twin: "github",
        method: "POST",
        path: "/s/probe/mcp/call",
        status: 404,
        tool: "add_issue_comment",
        error: "Issue not found",
      },
    ],
  );
  const text = formatFindings(findings);
  for (const needle of [
    "examples/pr-summary-agent",
    "comment_on_pull_request",
    "404",
    "add_issue_comment",
    "Issue not found",
    SEED,
    "pull_number",
  ]) {
    assert(text.includes(needle), `the failure report names ${needle}`);
  }
}

// ── the driver, against a real in-process GitHub twin ────────────────────────
// No model, no Docker, no network beyond loopback: `serve()` binds a port and
// the fixture example's tools talk to it.
//
// `withSharedTypesRuntime` is not optional here. `@pome-sh/shared-types` exports
// `./src/index.ts` with no dist build, so under plain `node` the twin packages'
// import chain lands on TypeScript that node's type-stripping cannot follow
// (`./recorder-events.js` does not exist). contract/run.mjs hits the same wall
// and solves it the same way.
await withSharedTypesRuntime(async () => {
  const { serve, createRecorderStore } = await import("@pome-sh/sdk/server");
  const { githubTwinDefinition, openGitHubCloneDatabase } = await import("@pome-sh/twin-github");
  const { sign } = await import("hono/jwt");

  const port = await freePort();
  const fixtureDir = join(ROOT, "scripts/fixtures/probe-examples/refused");
  const seed = JSON.parse(readFileSync(join(fixtureDir, "tasks/01-probe.seed.json"), "utf8"));
  const store = createRecorderStore();
  process.env.TWIN_AUTH_SECRET = PROBE_SECRET;
  const twin = await serve(githubTwinDefinition, {
    port,
    hostname: "127.0.0.1",
    db: openGitHubCloneDatabase(":memory:"),
    seed,
    recorder: store,
    runId: "probe",
  });
  const token = await sign(
    { sid: "probe", team_id: "tm_probe", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 3600 },
    PROBE_SECRET,
  );

  const spec = {
    module: join(fixtureDir, "tools.mjs"),
    export: "buildTools",
    config: { mcpUrl: `http://127.0.0.1:${port}/s/probe/mcp`, token },
    probes: [{ tool: "comment_on_issue", args: { owner: "acme", repo: "widgets", issue_number: 1, body: "probe" } }],
  };
  // NOT spawnSync. The twin serves from THIS process's event loop, and
  // spawnSync blocks it — the child would wait forever on a frozen server.
  const child = await new Promise((done) => {
    const proc = spawn(process.execPath, [join(ROOT, "scripts/example-tool-probe-driver.mjs")], {
      env: { ...process.env, POME_PROBE_SPEC: JSON.stringify(spec) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (buf) => { stdout += buf.toString(); });
    proc.stderr.on("data", (buf) => { stderr += buf.toString(); });
    proc.on("close", () => done({ stdout, stderr }));
  });
  await twin.close();

  const lines = child.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const tools = lines.find((line) => line.kind === "tools");
  assert(tools && tools.names.includes("comment_on_issue"), `the driver reports the built tool table (stderr: ${child.stderr})`);
  const probe = lines.find((line) => line.kind === "probe");
  assert(
    probe && probe.calls.some((call) => call.status === 404),
    "the driver reports the twin's 404 even though the example swallowed it",
  );
  assert(probe.threw === null, "the fixture's twin() really did swallow the 404 — so the wire is the only oracle");

  const tape = store.events();
  assert(
    tape.some((event) => event.status === 404 && event.tool === "add_issue_comment"),
    "the twin's own tape carries the 404 and stamps the action (F-1125, MCP surface)",
  );
});

// ── the whole gate, end to end, over the fixture examples ───────────────────
await withSharedTypesRuntime(async () => {
  const { probeExample } = await import("./probe-example-tools.mjs");
  const opts = { repoRoot: ROOT, examplesDir: join(ROOT, "scripts/fixtures/probe-examples") };
  const base = {
    seed: "tasks/01-probe.seed.json",
    module: "tools.mjs",
    export: "buildTools",
    config: { mcpUrl: "$github.mcp", token: "$token" },
  };

  const sound = await probeExample(
    "sound",
    {
      ...base,
      probes: [
        { tool: "list_open_issues", args: { owner: "acme", repo: "widgets" } },
        { tool: "comment_on_issue", args: { owner: "acme", repo: "widgets", issue_number: 1, body: "probe" } },
      ],
    },
    opts,
  );
  assert(sound.length === 0, `a sound example produces no findings (got: ${JSON.stringify(sound)})`);

  const refused = await probeExample(
    "refused",
    {
      ...base,
      probes: [{ tool: "comment_on_issue", args: { owner: "acme", repo: "widgets", issue_number: 1, body: "probe" } }],
    },
    opts,
  );
  assert(
    refused.length === 1 && refused[0].kind === "refused",
    `a refused tool is caught (got: ${JSON.stringify(refused)})`,
  );
  const text = formatFindings(refused);
  assert(text.includes("examples/refused"), "the end-to-end report names the example");
  assert(text.includes("comment_on_issue"), "the end-to-end report names the tool");
  assert(text.includes("404"), "the end-to-end report carries the twin's status");
  assert(text.includes("add_issue_comment"), "the end-to-end report names the twin action, read off the tape");
  assert(text.includes("Issue not found"), "the end-to-end report carries the twin's error text");

  // The anti-drift clause, end to end: drop a probe and the gate still reds.
  const drifted = await probeExample(
    "sound",
    { ...base, probes: [{ tool: "list_open_issues", args: { owner: "acme", repo: "widgets" } }] },
    opts,
  );
  assert(
    drifted.some((finding) => finding.kind === "unprobed-tool" && finding.tool === "comment_on_issue"),
    `a registered tool with no probe reds the gate end to end (got: ${JSON.stringify(drifted)})`,
  );
});

// ── the gate is actually wired into CI ──────────────────────────────────────
// A gate nothing runs is the failure mode this ticket exists to prevent.
{
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert(ci.includes("npm run probe:examples"), "ci.yml runs the probe gate");
  assert(ci.includes("node scripts/probe-example-tools.test.mjs"), "ci.yml runs the probe gate's own tests");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert(
    pkg.scripts["probe:examples"] === "node scripts/probe-example-tools.mjs",
    "package.json declares probe:examples",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("probe-example-tools: all assertions passed.");
