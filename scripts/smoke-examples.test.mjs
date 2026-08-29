#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for smoke-examples. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SETTLE_MS,
  OUTBOUND_MARKER,
  MARK_OUTBOUND_ENV,
  classifyLaunch,
  discoverExamples,
  assertAliveFloor,
  assertReportedCount,
  assertEveryExampleEmitsMarker,
  missingLiveEnv,
  resolveLiveFlag,
  launchEnv,
  LIVE_REQUIRED_ENV,
} from "./smoke-examples.mjs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  } else {
    console.log(`ok - ${name}`);
  }
}

{
  const v = classifyLaunch({ output: '{"decisions":[],"reports":[]}', stillRunningAtSettle: false, exitCode: 0 });
  check("exit 0 before settle with no benign signature reds", v.status, "fail");
  assert.match(v.reason, /exited code 0/);
}

{
  const v = classifyLaunch({ output: "boom, something broke", stillRunningAtSettle: false, exitCode: 1 });
  check("exit 1 before settle with no benign signature reds", v.status, "fail");
  assert.match(v.reason, /exited code 1/);
}

{
  const tdzOutput = "ReferenceError: Cannot access 'TwinMcpClient' before initialization";
  check(
    "TDZ crash reds even though it exits fast",
    classifyLaunch({ output: tdzOutput, stillRunningAtSettle: false, exitCode: 1 }).status,
    "fail",
  );
  check(
    "TDZ crash reds even on exit 0",
    classifyLaunch({ output: tdzOutput, stillRunningAtSettle: false, exitCode: 0 }).status,
    "fail",
  );
  check(
    "TDZ crash reds even if it also matches a benign signature (TDZ wins)",
    classifyLaunch({ output: `ECONNREFUSED ${tdzOutput}`, stillRunningAtSettle: false, exitCode: 1 }).status,
    "fail",
  );
  check(
    "TDZ crash reds even if the process is still alive at the settle",
    classifyLaunch({ output: tdzOutput, stillRunningAtSettle: true }).status,
    "fail",
  );
}

{
  const v = classifyLaunch({
    output: `${OUTBOUND_MARKER}\nTypeError: fetch failed\n  ECONNREFUSED 127.0.0.1:59321`,
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("marker + connection refused before settle is 'reached', not 'ok'", v.status, "reached");
  assert.match(v.reason, /connection refused/);
  assert.match(v.reason, new RegExp(OUTBOUND_MARKER));
}
{
  const v = classifyLaunch({
    output: `${OUTBOUND_MARKER}\nUnauthenticated request to AI Gateway.`,
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("marker + AI Gateway auth rejection before settle is 'reached'", v.status, "reached");
}

{
  for (const output of [
    "TypeError: fetch failed\n  ECONNREFUSED 127.0.0.1:59321",
    "Claude Code returned an error result: … 401 invalid x-api-key",
    "Claude Code process exited with code 1. stderr: 401 invalid x-api-key",
    "Unauthenticated request to AI Gateway.",
  ]) {
    const v = classifyLaunch({ output, stillRunningAtSettle: false, exitCode: 1 });
    check(
      `no marker, no reached, however benign the text looks: ${JSON.stringify(output.slice(0, 30))}`,
      v.status,
      "fail",
    );
    assert.match(v.reason, new RegExp(OUTBOUND_MARKER));
  }
}

{
  for (const [label, output] of [
    [
      "the `claude` binary never resolved",
      `${OUTBOUND_MARKER}\nError: Claude Code native binary not found at /nonexistent/claude. Please ensure Claude Code is installed`,
    ],
    [
      "the twin URL never parsed",
      `${OUTBOUND_MARKER}\nTypeError: Failed to parse URL\n  code: 'ERR_INVALID_URL',\n  input: 'ht!tp://[bad/gmail/v1/users/me/profile'`,
    ],
    [
      "a module never resolved",
      `${OUTBOUND_MARKER}\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'ai'`,
    ],
  ]) {
    const v = classifyLaunch({ output, stillRunningAtSettle: false, exitCode: 1 });
    check(`marker + a pre-outbound crash is a fail, not reached (${label})`, v.status, "fail");
    assert.match(v.reason, /reached its outbound call SITE/);
  }
}

{
  const wonRace = classifyLaunch({
    output: `${OUTBOUND_MARKER}\nClaude Code returned an error result: … 401 invalid x-api-key`,
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  const lostRace = classifyLaunch({
    output:
      `${OUTBOUND_MARKER}\nClaude Code process exited with code 1. stderr: 401 invalid x-api-key`,
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("SDK error shape A (won the race) is reached", wonRace.status, "reached");
  check("SDK error shape B (lost the race) is reached too", lostRace.status, "reached");
  check("both racing shapes agree on the verdict", wonRace.status, lostRace.status);
}

{
  const realCiOutput = {
    "gmail-retry-notify":
      "[TypeError: fetch failed] {\n  [cause]: Error: connect ECONNREFUSED 127.0.0.1:59321\n" +
      "    errno: -111,\n    code: 'ECONNREFUSED',\n    syscall: 'connect',\n  }\n}\nNode.js v24.18.0",
    "merge-agent":
      "Alternatively, you can use a provider module instead of the AI Gateway.\n\n" +
      "Learn more: \x1b[34mhttps://ai-sdk.dev/unauthenticated-ai-gateway\x1b[0m\n\nNode.js v24.18.0",
    "minimal-viktor":
      '{"error":"\x1b[1m\x1b[31mUnauthenticated request to AI Gateway.\x1b[0m\\n\\n' +
      'To authenticate, set the AI_GATEWAY_API_KEY environment variable with your API key.\\n"}',
    "pr-summary-agent":
      "— agent finished —\nInvalid API key · Fix external API key\n(0 in / 0 out, $0.0000)\n" +
      "/home/runner/work/digital-twins/digital-twins/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:108",
  };
  for (const [name, output] of Object.entries(realCiOutput)) {
    const v = classifyLaunch({
      output: `${OUTBOUND_MARKER}\n${output}`,
      stillRunningAtSettle: false,
      exitCode: 1,
    });
    check(`real CI output for ${name} (with marker) classifies as reached`, v.status, "reached");
    assert.match(
      v.reason,
      /an outbound call failed \(.+\)/,
      `${name}: no BENIGN_FAILURE_SIGNATURES entry recognized this real CI output`,
    );
  }
}

{
  const v = classifyLaunch({
    output: `${OUTBOUND_MARKER}\n{"error":"list_collaborators acme/api failed: fetch failed"}`,
    stillRunningAtSettle: false,
    exitCode: 0,
    live: false,
  });
  check("marker + exit 0 on the PR leg is a fail, not reached", v.status, "fail");
  assert.match(v.reason, /swallowed/);
}

{
  for (const output of [
    "",
    '{"task":"...","repo":"triage/summarize","decisions":[],"reports":[]}',
    "Error: something went wrong",
    "request failed",
    "TypeError: Cannot read properties of undefined (reading 'ref')",
    "AssertionError: expected 1 to equal 0",
    "merge blocked: author drive-by-dev is not an authorized collaborator https://github.com/o/r/pull/1",
    "TypeError: x is not a function\n    at run (/app/src/graph.ts:401:9)",
  ]) {
    check(
      `broken-example output is not excused: ${JSON.stringify(output.slice(0, 40))}`,
      classifyLaunch({ output, stillRunningAtSettle: false, exitCode: 0 }).status,
      "fail",
    );
  }
}

{
  const v = classifyLaunch({ output: "unrecognized boom", stillRunningAtSettle: false, exitCode: 1 });
  assert.match(v.reason, new RegExp(OUTBOUND_MARKER));
  check("an unrecognized failure names the marker it never saw", v.status, "fail");
}

{
  const v = classifyLaunch({ output: "· thinking… 2s", stillRunningAtSettle: true });
  check("still running at the settle is ok", v.status, "ok");
  assert.match(v.reason, new RegExp(String(SETTLE_MS)));
}

{
  const emptyDir = mkdtempSync(join(tmpdir(), "smoke-examples-empty-"));
  try {
    check("an examples directory with nothing runnable discovers zero", discoverExamples(emptyDir), []);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "smoke-examples-discover-"));
  try {
    mkdirSync(join(dir, "runnable"));
    writeFileSync(join(dir, "runnable", "package.json"), JSON.stringify({ scripts: { start: "tsx src/index.ts" } }));
    mkdirSync(join(dir, "library-only"));
    writeFileSync(join(dir, "library-only", "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    check("only packages declaring a start script are discovered", discoverExamples(dir), ["runnable"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const zero = assertAliveFloor({ live: true, okCount: 0, total: 8 });
  check("zero alive on the live leg fails the floor", zero.ok, false);
  assert.match(zero.message, /0 of 8/);
  assert.match(zero.message, />= 1/);

  const one = assertAliveFloor({ live: true, okCount: 1, total: 8 });
  check(">= 1 alive on the live leg meets the floor", one.ok, true);

  const many = assertAliveFloor({ live: true, okCount: 8, total: 8 });
  check("every example alive still meets the floor", many.ok, true);

  const notLive = assertAliveFloor({ live: false, okCount: 0, total: 8 });
  check("the floor is a no-op when not on the live leg", notLive.ok, true);
  check("a no-op floor carries no message", notLive.message, null);
}

{
  check(
    "every required var is reported missing from an empty env",
    missingLiveEnv({}).sort(),
    [...LIVE_REQUIRED_ENV].sort(),
  );
  check(
    "a fully-populated env reports nothing missing",
    missingLiveEnv({ ANTHROPIC_API_KEY: "sk-ant-real", POME_AUTH_TOKEN: "real-jwt" }),
    [],
  );
  check(
    "a partially-populated env names only what is absent",
    missingLiveEnv({ ANTHROPIC_API_KEY: "sk-ant-real" }),
    ["POME_AUTH_TOKEN"],
  );
  check(
    "an empty-string secret is named as absent, not accepted",
    missingLiveEnv({ ANTHROPIC_API_KEY: "", POME_AUTH_TOKEN: "" }).sort(),
    [...LIVE_REQUIRED_ENV].sort(),
  );
  check(
    "a whitespace-only secret is named as absent, not accepted",
    missingLiveEnv({ ANTHROPIC_API_KEY: "   ", POME_AUTH_TOKEN: "\t\n " }).sort(),
    [...LIVE_REQUIRED_ENV].sort(),
  );
  check(
    "one real secret + one whitespace-only secret names only the blank one",
    missingLiveEnv({ ANTHROPIC_API_KEY: "sk-ant-real", POME_AUTH_TOKEN: " " }),
    ["POME_AUTH_TOKEN"],
  );
}

{
  check("unset means the PR leg, with no error", resolveLiveFlag(undefined), {
    live: false,
    error: null,
  });
  check('"" means the PR leg, with no error', resolveLiveFlag(""), { live: false, error: null });
  check('"1" is the live leg', resolveLiveFlag("1").live, true);
  check('"1" carries no error', resolveLiveFlag("1").error, null);
  for (const bogus of ["true", "TRUE", "yes", "on", "0", "1 ", " 1", "2", "live"]) {
    const r = resolveLiveFlag(bogus);
    check(`${JSON.stringify(bogus)} is not the live leg`, r.live, false);
    assert.ok(
      r.error && r.error.includes(JSON.stringify(bogus)),
      `${JSON.stringify(bogus)} must produce an error naming the value it saw, got ${r.error}`,
    );
  }
}

{
  const realWiring = {
    ANTHROPIC_API_KEY: "sk-ant-real",
    POME_AUTH_TOKEN: "real-jwt",
    POME_GITHUB_MCP_URL: "http://127.0.0.1:3333/s/standalone/mcp",
    POME_PREFLIGHT: "1",
  };

  const live = launchEnv(realWiring, true);
  assert.ok(live.POME_TASK?.trim(), "the LIVE leg must supply a non-blank POME_TASK");
  assert.match(
    live.VIKTOR_MODEL ?? "",
    /^anthropic\//,
    "the LIVE leg must pin an anthropic/* model slug so ANTHROPIC_API_KEY alone suffices",
  );
  check(
    "the LIVE leg does not fake an AI_GATEWAY_API_KEY",
    live.AI_GATEWAY_API_KEY === undefined,
    true,
  );
  check(
    "a caller-supplied VIKTOR_MODEL wins on the LIVE leg",
    launchEnv({ ...realWiring, VIKTOR_MODEL: "openai/gpt-5" }, true).VIKTOR_MODEL,
    "openai/gpt-5",
  );
  check(
    "the LIVE leg leaves real twin wiring untouched",
    live.POME_GITHUB_MCP_URL,
    "http://127.0.0.1:3333/s/standalone/mcp",
  );
  check("the LIVE leg keeps the real model key", live.ANTHROPIC_API_KEY === "sk-ant-real", true);
  check("the LIVE leg never re-enables POME_PREFLIGHT", live.POME_PREFLIGHT, undefined);
  for (const [k, v] of Object.entries(live)) {
    assert.ok(
      !String(v).includes("59321"),
      `LIVE leg leaked the dead loopback port into ${k}=${v}`,
    );
  }
  check(
    "a caller-supplied POME_TASK wins on the LIVE leg",
    launchEnv({ ...realWiring, POME_TASK: "real task" }, true).POME_TASK,
    "real task",
  );
  assert.ok(
    launchEnv({ ...realWiring, POME_TASK: "  " }, true).POME_TASK.trim(),
    "a blank caller POME_TASK must not reach requiredEnv() as blank",
  );

  const pr = launchEnv(realWiring, false);
  check("the PR leg still overlays the dead loopback port", pr.POME_GITHUB_MCP_URL, "http://127.0.0.1:59321/s/smoke/mcp");
  // The hosted control plane is dead-wired on the PR leg for a reason the twin
  // bases above do not have: api.pome.sh is BILLABLE. `integration-examples/braintrust` mints one
  // sandbox per dataset row, so a PR leg that let POME_API_URL fall through to
  // its production default would spend real quota on every PR — and on every
  // logged-in developer's `npm run smoke:examples`, whose real POME_API_KEY is
  // inherited from their shell and is NOT overlaid here.
  check(
    "the PR leg overlays the hosted control-plane base too, so no PR can mint a billable sandbox",
    pr.POME_API_URL,
    "http://127.0.0.1:59321",
  );
  check(
    "the LIVE leg leaves a caller-supplied POME_API_URL alone",
    launchEnv({ ...realWiring, POME_API_URL: "https://api.pome.sh" }, true).POME_API_URL,
    "https://api.pome.sh",
  );
  // `integration-examples/langsmith` calls api.smith.langchain.com, whose free tier is metered on
  // traces. Same argument as POME_API_URL: the PR leg is uncredentialed by design
  // and a developer's own LANGSMITH_API_KEY is inherited from their shell, not
  // overlaid here.
  check(
    "the PR leg overlays the LangSmith endpoint too, so no PR can spend a reader's trace quota",
    pr.LANGSMITH_ENDPOINT,
    "http://127.0.0.1:59321",
  );
  check(
    "the LIVE leg leaves a caller-supplied LANGSMITH_ENDPOINT alone",
    launchEnv({ ...realWiring, LANGSMITH_ENDPOINT: "https://api.smith.langchain.com" }, true)
      .LANGSMITH_ENDPOINT,
    "https://api.smith.langchain.com",
  );
  check(
    "the PR leg still overlays the invalid model key",
    pr.ANTHROPIC_API_KEY === "sk-ant-smoke-invalid",
    true,
  );
  check(
    "the PR leg still overlays the fake gateway key",
    pr.AI_GATEWAY_API_KEY === "smoke-invalid",
    true,
  );
  check("the PR leg does not pin a model slug", pr.VIKTOR_MODEL, undefined);
  assert.ok(pr.POME_TASK?.trim(), "the PR leg must supply a non-blank POME_TASK");
  check("the PR leg never re-enables POME_PREFLIGHT", pr.POME_PREFLIGHT, undefined);
  check("the LIVE leg tells examples to emit the marker", live[MARK_OUTBOUND_ENV], "1");
  check("the PR leg tells examples to emit the marker too", pr[MARK_OUTBOUND_ENV], "1");
}

{
  const liveFast = classifyLaunch({
    output: "Triaged 0 open items in acme/api — nothing to do.",
    stillRunningAtSettle: false,
    exitCode: 0,
    live: true,
  });
  check("a fast exit-0 on the live leg is still a FAIL", liveFast.status, "fail");
  assert.match(liveFast.reason, /credentialed leg/);
  assert.match(liveFast.reason, /CORRECT but FAST/);

  const prFast = classifyLaunch({
    output: "Triaged 0 open items in acme/api — nothing to do.",
    stillRunningAtSettle: false,
    exitCode: 0,
    live: false,
  });
  check("a fast exit-0 off the live leg is still a FAIL", prFast.status, "fail");
  assert.ok(
    !prFast.reason.includes("credentialed leg"),
    "the PR leg's failure message must not carry the live-only note",
  );
  assert.ok(
    !classifyLaunch({
      output: "unrecognized boom",
      stillRunningAtSettle: false,
      exitCode: 1,
      live: true,
    }).reason.includes("credentialed leg"),
    "a non-zero exit must not be excused as a fast correct completion",
  );
}

{
  const all8 = [
    "gmail-retry-notify",
    "merge-agent",
    "minimal-viktor",
    "minimal-viktor-langgraph",
    "pr-summary-agent",
    "pr-summary-review",
    "support-triage",
    "triage-agent",
  ];
  const clean = assertReportedCount(all8, all8);
  check("every discovered example reporting is a pass", clean.ok, true);
  check("a clean pass carries no message", clean.message, null);

  const oneVanished = assertReportedCount(all8, all8.filter((n) => n !== "pr-summary-agent"));
  check("one missing example fails the count assertion", oneVanished.ok, false);
  assert.match(oneVanished.message, /pr-summary-agent/);
  assert.match(oneVanished.message, /1 of 8/);
  assert.match(oneVanished.message, /neither OK, REACHED-OUTBOUND, nor FAILED/);

  const droppedAndDuplicated = assertReportedCount(all8, [
    ...all8.filter((n) => n !== "triage-agent"),
    "merge-agent", // duplicate report, same length as the 8 discovered
  ]);
  check(
    "a same-length report that drops one name is still caught",
    droppedAndDuplicated.ok,
    false,
  );
  assert.match(droppedAndDuplicated.message, /triage-agent/);

  check("nothing discovered, nothing reported is a pass", assertReportedCount([], []).ok, true);
}

{
  const dir = mkdtempSync(join(tmpdir(), "smoke-examples-marker-"));
  try {
    mkdirSync(join(dir, "via-adapter", "src"), { recursive: true });
    writeFileSync(
      join(dir, "via-adapter", "package.json"),
      JSON.stringify({
        scripts: { start: "tsx src/index.ts" },
        dependencies: { "@pome-sh/adapter-claude-sdk": "file:../../packages/adapter-claude-sdk" },
      }),
    );
    writeFileSync(join(dir, "via-adapter", "src", "index.ts"), "import { query } from '@pome-sh/adapter-claude-sdk';\n");

    mkdirSync(join(dir, "via-literal", "src"), { recursive: true });
    writeFileSync(
      join(dir, "via-literal", "package.json"),
      JSON.stringify({ scripts: { start: "tsx src/index.ts" } }),
    );
    writeFileSync(
      join(dir, "via-literal", "src", "index.ts"),
      `if (process.env.${MARK_OUTBOUND_ENV} === "1") console.error("${OUTBOUND_MARKER}");\n`,
    );

    mkdirSync(join(dir, "forgot-it", "src"), { recursive: true });
    writeFileSync(
      join(dir, "forgot-it", "package.json"),
      JSON.stringify({ scripts: { start: "tsx src/index.ts" } }),
    );
    writeFileSync(join(dir, "forgot-it", "src", "index.ts"), "console.log('does real work, prints nothing marker-shaped');\n");

    mkdirSync(join(dir, "registry-pinned", "src"), { recursive: true });
    writeFileSync(
      join(dir, "registry-pinned", "package.json"),
      JSON.stringify({
        scripts: { start: "tsx src/index.ts" },
        dependencies: { "@pome-sh/adapter-claude-sdk": "0.3.5" },
      }),
    );
    writeFileSync(join(dir, "registry-pinned", "src", "index.ts"), "import { query } from '@pome-sh/adapter-claude-sdk';\n");

    mkdirSync(join(dir, "mentions-it", "src"), { recursive: true });
    writeFileSync(
      join(dir, "mentions-it", "package.json"),
      JSON.stringify({ scripts: { start: "tsx src/index.ts" } }),
    );
    writeFileSync(
      join(dir, "mentions-it", "src", "index.ts"),
      `// the smoke gate looks for ${OUTBOUND_MARKER} here.\nconsole.log("no emission");\n`,
    );

    const clean = assertEveryExampleEmitsMarker(dir, ["via-adapter", "via-literal"]);
    check("an example covered by the shared seam or its own literal passes", clean.ok, true);
    check("a clean pass carries no message", clean.message, null);

    const withGap = assertEveryExampleEmitsMarker(dir, ["via-adapter", "via-literal", "forgot-it"]);
    check("an example with no route to the marker reds the guard", withGap.ok, false);
    assert.match(withGap.message, /forgot-it/);
    assert.match(withGap.message, new RegExp(OUTBOUND_MARKER));
    assert.ok(!withGap.message.includes("via-adapter"), "a covered example must not be named as missing");
    assert.ok(!withGap.message.includes("via-literal"), "a covered example must not be named as missing");

    const registryPin = assertEveryExampleEmitsMarker(dir, ["registry-pinned"]);
    check("a REGISTRY-pinned adapter dependency does not buy coverage", registryPin.ok, false);
    assert.match(registryPin.message, /registry-pinned/);

    const mention = assertEveryExampleEmitsMarker(dir, ["mentions-it"]);
    check("the marker mentioned in a comment does not buy coverage", mention.ok, false);
    assert.match(mention.message, /mentions-it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const real = discoverExamples();
  const coverage = assertEveryExampleEmitsMarker(examplesDirForRepo(), real);
  check("every real discovered example has a route to the marker", coverage.ok, true);
}

function examplesDirForRepo() {
  return fileURLToPath(new URL("../agent-examples", import.meta.url));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke-examples.mjs checks passed.");
