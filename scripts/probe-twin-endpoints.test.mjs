#!/usr/bin/env node
/**
 * Regression coverage for scripts/probe-twin-endpoints.mjs.
 *
 * The gate exists because nothing called every endpoint a twin declares.
 * Measured on `51b5efe`: the five twins declare 137 MCP tools, the
 * example probe gate reached 9 of them (all github's), and 23 — slack's 8 and
 * linear's 15 — were reached by nothing over the MCP wire at all, including by
 * their own test suites, which exercise them through `executeTool()` on the
 * domain and never cross the dispatch layer. `comment_on_pull_request` was a
 * dispatch-layer defect, so a domain-level call is exactly the shape of test
 * that was green through it.
 *
 * The cases below are written from that measurement.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateTwinProbeRun,
  formatFindings,
  probeTwin,
  resolveArgs,
  resolvePath,
  TWIN_BOOT,
} from "./probe-twin-endpoints.mjs";

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

// ── resolveArgs ─────────────────────────────────────────────────────────────
// A later probe routinely needs an id an earlier one minted. Without this the
// manifest could only ever probe tools that read seeded state, which is the
// half of every twin that was already covered.
{
  const results = {
    merge_pr: { number: 7, head: { sha: "abc" } },
    main_commits: [{ sha: "deadbeef" }],
    scratch_file: { content: { sha: "cafe" } },
  };
  const out = resolveArgs(
    {
      owner: "acme",
      pull_number: "$merge_pr.number",
      sha: "$main_commits.0.sha",
      nested: { file_sha: "$scratch_file.content.sha" },
      list: ["$merge_pr.number", 3],
      literal: "not-a-reference",
      count: 5,
    },
    results,
  );
  assert(out.pull_number === 7, "resolveArgs fills a dotted reference");
  assert(out.sha === "deadbeef", "resolveArgs indexes into an array result");
  assert(out.nested.file_sha === "cafe", "resolveArgs descends into nested objects");
  assert(out.list[0] === 7 && out.list[1] === 3, "resolveArgs walks arrays");
  assert(out.owner === "acme" && out.literal === "not-a-reference" && out.count === 5, "resolveArgs passes literals through");
}

// An unresolvable reference throws rather than resolving to undefined: a
// silently absent `pull_number` makes the twin answer 422 and the gate would
// report a twin defect that is really a manifest typo.
assertThrows(
  () => resolveArgs({ pull_number: "$never_ran.number" }, { merge_pr: { number: 7 } }),
  "$never_ran.number",
  "resolveArgs rejects a reference to a probe that has not run",
);
assertThrows(
  () => resolveArgs({ sha: "$merge_pr.head.sha" }, { merge_pr: { number: 7 } }),
  "$merge_pr.head.sha",
  "resolveArgs rejects a path the earlier result does not carry",
);

// ── evaluateTwinProbeRun: the five ways the gate goes red ───────────────────
const DECLARED = [{ name: "add_issue_comment" }, { name: "merge_pull_request" }];
function call(status, over = {}) {
  return { status, method: "POST", path: "/s/probe/mcp", error: null, args: {}, ...over };
}

assert(
  evaluateTwinProbeRun({
    twin: "github",
    declared: DECLARED,
    probes: [{ tool: "add_issue_comment" }, { tool: "merge_pull_request" }],
    calls: [call(200), call(200)],
  }).length === 0,
  "evaluateTwinProbeRun is silent on a clean run",
);

// 0. setup steps: state-building, never coverage.
//
// twin-github's three release readers only answer once a release exists, and
// GitHub declares no `create_release` MCP tool for the twin to serve — so the
// write that builds their subject is a REST call, not a probe. The risk that
// buys is a setup step quietly counting as coverage for the tool it names, which
// would make the anti-drift clause silent on exactly the tools hardest to reach.
{
  const setup = { method: "POST", path: "/repos/acme/api/releases" };
  const findings = evaluateTwinProbeRun({
    twin: "github",
    declared: [...DECLARED, { name: "merge_pull_request" }],
    // A setup step naming the SAME route family as a declared tool, and no probe
    // for `merge_pull_request`.
    probes: [{ tool: "add_issue_comment" }, { setup, as: "release" }],
    calls: [call(200), call(201, { method: "POST", path: "/s/probe/repos/acme/api/releases" })],
  });
  assert(
    findings.some((f) => f.kind === "unprobed-endpoint" && f.tool === "merge_pull_request"),
    "a setup step does not count as coverage for a tool nothing probes",
  );
  assert(
    !findings.some((f) => f.kind === "unknown-endpoint"),
    "a setup step is not held to the declared-tool list — it has no tool identity",
  );

  // …but it must still WORK. A silent 4xx here surfaces later as an
  // unexplained refusal on whichever probe depended on the state it built.
  const broken = evaluateTwinProbeRun({
    twin: "github",
    declared: DECLARED,
    probes: [{ tool: "add_issue_comment" }, { tool: "merge_pull_request" }, { setup }],
    calls: [call(200), call(200), call(422, { path: "/s/probe/repos/acme/api/releases" })],
  });
  assert(
    broken.some((f) => f.kind === "refused" && f.tool === "setup POST /repos/acme/api/releases"),
    "a failing setup step reds the gate, named by its route",
  );
}

// 1. refused — THE incident, in the shape this gate sees it. The twin answered
// `404 Issue not found` for add_issue_comment at a pull request's number.
{
  const findings = evaluateTwinProbeRun({
    twin: "github",
    declared: DECLARED,
    probes: [{ tool: "add_issue_comment" }, { tool: "merge_pull_request" }],
    calls: [call(404, { error: "Issue not found", args: { issue_number: 2 } }), call(200)],
  });
  assert(findings.length === 1 && findings[0].kind === "refused", "a 4xx twin answer is a `refused` finding");
  assert(findings[0].tool === "add_issue_comment", "the refused finding names the declared endpoint");
}

// A 5xx counts too — the claim is "the twin did not refuse", not "not 4xx".
assert(
  evaluateTwinProbeRun({
    twin: "stripe",
    declared: [{ name: "create_refund" }],
    probes: [{ tool: "create_refund" }],
    calls: [call(500)],
  })[0].kind === "refused",
  "a 5xx twin answer is also `refused`",
);

// MCP JSON-RPC answers HTTP 200 for a tool that failed and reports the failure
// inside `result.isError`, so the gate reads the twin's recorded status. This
// asserts the finding turns on that recorded status alone.
assert(
  evaluateTwinProbeRun({
    twin: "linear",
    declared: [{ name: "save_issue" }],
    probes: [{ tool: "save_issue" }],
    calls: [call(422, { error: "Argument Validation Error" })],
  })[0].kind === "refused",
  "a tool failure the JSON-RPC transport answered 200 for is still `refused`",
);

// 2. unprobed-endpoint — the anti-drift clause, and the whole point of the
// ticket. The set comes from the twin's own tools/list, so a twin that gains a
// tool reds this line with no hand edit to any list.
{
  const findings = evaluateTwinProbeRun({
    twin: "slack",
    declared: [{ name: "slack_send_message" }, { name: "slack_get_reactions" }],
    probes: [{ tool: "slack_send_message" }],
    calls: [call(200)],
  });
  assert(findings.length === 1 && findings[0].kind === "unprobed-endpoint", "a declared tool with no probe is a finding");
  assert(findings[0].tool === "slack_get_reactions", "the unprobed-endpoint finding names the endpoint");
}

// 3. unknown-endpoint — a probe naming a tool the twin does not declare. This
// is what a renamed or deleted tool looks like from the manifest's side.
{
  const findings = evaluateTwinProbeRun({
    twin: "gmail",
    declared: [{ name: "list_labels" }],
    probes: [{ tool: "list_labels" }, { tool: "send_message" }],
    calls: [call(200), null],
  });
  assert(
    findings.some((f) => f.kind === "unknown-endpoint" && f.tool === "send_message"),
    "a probe for a tool the twin does not declare is a finding",
  );
}

// 4. stale-expect — the escape hatch expires loudly. Without this a twin fix
// leaves a permanent exemption behind, which is how a gate stops watching.
{
  const probes = [{ tool: "merge_pull_request", expect_status: 405, why: "the seeded PR is not mergeable" }];
  assert(
    evaluateTwinProbeRun({ twin: "github", declared: [{ name: "merge_pull_request" }], probes, calls: [call(405)] })
      .length === 0,
    "a declared expect_status excuses that exact status",
  );
  const findings = evaluateTwinProbeRun({
    twin: "github",
    declared: [{ name: "merge_pull_request" }],
    probes,
    calls: [call(200)],
  });
  assert(findings.length === 1 && findings[0].kind === "stale-expect", "an expect_status that no longer happens is a finding");
}

// 5. driver-error — the probe never got to ask the twin anything.
assert(
  evaluateTwinProbeRun({
    twin: "github",
    declared: DECLARED,
    probes: [{ tool: "add_issue_comment" }],
    calls: [{ failed: "unresolvable reference $merge_pr.number" }],
  })[0].kind === "driver-error",
  "a probe that could not be built is a finding",
);

// ── the report has to be readable without re-deriving anything ──────────────
{
  const text = formatFindings(
    evaluateTwinProbeRun({
      twin: "github",
      declared: DECLARED,
      probes: [{ tool: "add_issue_comment" }],
      calls: [
        call(404, { error: "Issue not found", args: { owner: "acme", repo: "api", issue_number: 2, body: "probe" } }),
      ],
    }),
  );
  for (const needle of ["github", "add_issue_comment", "404", "POST", "/s/probe/mcp", "Issue not found", "issue_number"]) {
    assert(text.includes(needle), `the failure report names ${needle}`);
  }
}

// ── end to end, against real in-process twins ───────────────────────────────
// No model, no API key, no Docker, no socket: each twin runs in this process on
// `:memory:` SQLite and is driven through Hono's `app.request`.

// The PR-comment regression, as a live fixture. `add_issue_comment` at a PULL
// REQUEST's number is the call that answered `404 Issue not found` for the
// whole life of agent-examples/pr-summary-agent and agent-examples/pr-summary-review.
{
  const findings = await probeTwin("github", {
    probes: [
      { tool: "create_branch", args: { owner: "acme", repo: "api", branch: "regression" } },
      {
        tool: "create_or_update_file",
        args: { owner: "acme", repo: "api", branch: "regression", path: "r.ts", message: "m", content: "export const r = 1;\n" },
      },
      {
        tool: "create_pull_request",
        args: { owner: "acme", repo: "api", title: "regression", head: "regression", base: "main" },
        as: "pr",
      },
      {
        tool: "add_issue_comment",
        args: { owner: "acme", repo: "api", issue_number: "$pr.number", body: "probe" },
      },
    ],
  });
  const refused = findings.filter((f) => f.kind === "refused");
  assert(refused.length === 0, `commenting at a pull request's number is answered (got: ${JSON.stringify(refused)})`);
}

// ...and the gate really would have caught it. Same tool, at a number no issue
// and no pull request carries: the twin answers 404 and the gate names it.
{
  const findings = await probeTwin("github", {
    probes: [{ tool: "add_issue_comment", args: { owner: "acme", repo: "api", issue_number: 4242, body: "probe" } }],
  });
  const refused = findings.find((f) => f.kind === "refused" && f.tool === "add_issue_comment");
  assert(refused !== undefined, `a 404 on add_issue_comment reds the gate (got: ${JSON.stringify(findings)})`);
  const text = formatFindings([refused]);
  assert(text.includes("404"), "the end-to-end report carries the twin's status");
  assert(text.includes("Issue not found"), "the end-to-end report carries the twin's own error text");
  assert(text.includes("4242"), "the end-to-end report carries the arguments the probe sent");
}

// The anti-drift clause, end to end, on the twin that most needs it: slack
// declared 11 tools and its own suite reached 3 over the wire. It declares 18
// now (the table was replaced with Slack's own), and the count below is
// derived from the twin rather than typed, so the clause survives the next one.
{
  // Derived, not typed: an empty manifest reds one unprobed-endpoint per
  // declared tool, which is the count the one-probe run should leave behind
  // minus the tool it covers.
  const declaredCount = (await probeTwin("slack", { probes: [] })).length;
  const findings = await probeTwin("slack", {
    probes: [{ tool: "slack_search_channels", args: { query: "general", limit: 10 } }],
  });
  const unprobed = findings.filter((f) => f.kind === "unprobed-endpoint");
  assert(
    unprobed.length === declaredCount - 1,
    `every declared tool with no probe reds the gate (got ${unprobed.length} of ${declaredCount - 1})`,
  );
  assert(
    unprobed.some((f) => f.tool === "slack_get_reactions"),
    "the anti-drift finding names each uncovered endpoint",
  );
}

// Every twin boots and answers tools/list. A boot recipe naming an export that
// does not exist would otherwise fail as a wall of identical 401s.
for (const id of Object.keys(TWIN_BOOT)) {
  const findings = await probeTwin(id, { probes: [] });
  assert(
    findings.length > 0 && findings.every((f) => f.kind === "unprobed-endpoint"),
    `twin ${id} boots and declares its tools (got: ${JSON.stringify(findings.slice(0, 2))})`,
  );
}

// ── the shipped manifest covers every declared endpoint ─────────────────────
// The gate proves this when it runs; this pins that the checked-in manifest is
// the state the gate passes in, so a red is news rather than the default.
{
  const manifest = JSON.parse(readFileSync(join(ROOT, "config/twin-endpoint-probes.json"), "utf8"));
  assert(
    Object.keys(manifest).sort().join(",") === Object.keys(TWIN_BOOT).sort().join(","),
    "the manifest covers exactly the twins the gate can boot",
  );
  for (const [id, entry] of Object.entries(manifest)) {
    const findings = await probeTwin(id, entry);
    assert(findings.length === 0, `twin ${id} is clean under the shipped manifest:\n${formatFindings(findings)}`);
  }
}

// ── the gate is actually wired into CI ──────────────────────────────────────
// A gate nothing runs is the failure mode this exists to prevent.
{
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert(ci.includes("npm run probe:twins"), "ci.yml runs the declared-endpoint gate");
  assert(ci.includes("node scripts/probe-twin-endpoints.test.mjs"), "ci.yml runs the gate's own tests");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert(pkg.scripts["probe:twins"] === "node scripts/probe-twin-endpoints.mjs", "package.json declares probe:twins");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("probe-twin-endpoints: all assertions passed.");

// resolvePath: a setup step addresses state an earlier probe minted, so
// `$alias` resolves in a path SEGMENT — and only in a whole segment, so a
// literal `$` cannot be mistaken for a reference.
{
  const results = { review_pr: { number: 4 } };
  assert(
    resolvePath("/repos/acme/api/pulls/$review_pr.number/comments", results) ===
      "/repos/acme/api/pulls/4/comments",
    "resolvePath resolves an alias in a path segment",
  );
  assert(
    resolvePath("/repos/acme/api/releases", results) === "/repos/acme/api/releases",
    "resolvePath leaves a literal path alone",
  );
  let threw = false;
  try {
    resolvePath("/repos/acme/api/pulls/$nope.number/comments", results);
  } catch {
    threw = true;
  }
  assert(threw, "resolvePath fails loudly on an unresolvable segment rather than sending the literal");
}
