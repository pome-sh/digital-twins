#!/usr/bin/env node
//
// Case table for probe-twin-endpoints. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.
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

{
  const setup = { method: "POST", path: "/repos/acme/api/releases" };
  const findings = evaluateTwinProbeRun({
    twin: "github",
    declared: [...DECLARED, { name: "merge_pull_request" }],
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

assert(
  evaluateTwinProbeRun({
    twin: "stripe",
    declared: [{ name: "create_refund" }],
    probes: [{ tool: "create_refund" }],
    calls: [call(500)],
  })[0].kind === "refused",
  "a 5xx twin answer is also `refused`",
);

assert(
  evaluateTwinProbeRun({
    twin: "linear",
    declared: [{ name: "save_issue" }],
    probes: [{ tool: "save_issue" }],
    calls: [call(422, { error: "Argument Validation Error" })],
  })[0].kind === "refused",
  "a tool failure the JSON-RPC transport answered 200 for is still `refused`",
);

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

assert(
  evaluateTwinProbeRun({
    twin: "github",
    declared: DECLARED,
    probes: [{ tool: "add_issue_comment" }],
    calls: [{ failed: "unresolvable reference $merge_pr.number" }],
  })[0].kind === "driver-error",
  "a probe that could not be built is a finding",
);

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

{
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

for (const id of Object.keys(TWIN_BOOT)) {
  const findings = await probeTwin(id, { probes: [] });
  assert(
    findings.length > 0 && findings.every((f) => f.kind === "unprobed-endpoint"),
    `twin ${id} boots and declares its tools (got: ${JSON.stringify(findings.slice(0, 2))})`,
  );
}

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
