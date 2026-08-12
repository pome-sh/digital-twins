#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `smoke-examples.mjs` (F-1478).
//
// The gate's whole job, before this ticket, was undermined by one gap: an
// exit inside SETTLE_MS was ALWAYS "OK", so an example that returned having
// done nothing looked identical to a healthy launch. `classifyLaunch()` is
// where that got fixed, so this suite drives it directly with synthetic
// evidence rather than spawning all eight real examples (slow, network- and
// timing-dependent — the real launches are exercised by `npm run
// smoke:examples` itself in CI).
//
// Four cases are the break-on-purpose scenarios F-1478 names explicitly:
// exits 0 immediately with no evidence of work, exits 1 immediately with no
// recognized benign reason, a module-body TDZ (F-900's subject — must never
// regress to a skip or a pass no matter what else changes here), and zero
// examples discovered.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SETTLE_MS, classifyLaunch, discoverExamples } from "./smoke-examples.mjs";

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

// ── break-on-purpose 1: exits 0 immediately, no signal of real work ────────
{
  const v = classifyLaunch({ output: '{"decisions":[],"reports":[]}', stillRunningAtSettle: false, exitCode: 0 });
  check("exit 0 before settle with no benign signature reds", v.status, "fail");
  assert.match(v.reason, /exited code 0/);
}

// ── break-on-purpose 2: exits 1 immediately, no recognized reason ──────────
{
  const v = classifyLaunch({ output: "boom, something broke", stillRunningAtSettle: false, exitCode: 1 });
  check("exit 1 before settle with no benign signature reds", v.status, "fail");
  assert.match(v.reason, /exited code 1/);
}

// ── break-on-purpose 3: a module-body TDZ still reds, whatever else is true ─
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

// ── an outbound-call failure is its own named verdict, distinct from ok ─────
{
  const v = classifyLaunch({
    output: "TypeError: fetch failed\n  ECONNREFUSED 127.0.0.1:59321",
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("connection refused before settle is 'reached', not 'ok'", v.status, "reached");
  assert.match(v.reason, /connection refused/);
}
{
  const v = classifyLaunch({
    output: "Unauthenticated request to AI Gateway.",
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("AI Gateway auth rejection before settle is 'reached'", v.status, "reached");
}

// ── the signature list is locked against REAL CI output, not invented text ──
//
// Every string below is copied verbatim from the `smoke:examples` job log of
// the F-1478 PR run (github.com/pome-sh/digital-twins/actions/runs/31614212888).
// This is the case that matters: the list decides whether the gate is usable in
// the only environment that gates anything, and a tightened pattern that no
// longer matches what CI actually prints reds all eight examples at once. If a
// dependency changes its error wording, this fails here — cheaply, naming the
// example — instead of in a CI run that reds everything.
{
  const realCiOutput = {
    "gmail-retry-notify":
      "[TypeError: fetch failed] {\n  [cause]: Error: connect ECONNREFUSED 127.0.0.1:59321\n" +
      "    errno: -111,\n    code: 'ECONNREFUSED',\n    syscall: 'connect',\n  }\n}\nNode.js v24.18.0",
    "merge-agent":
      "Alternatively, you can use a provider module instead of the AI Gateway.\n\n" +
      "Learn more: [34mhttps://ai-sdk.dev/unauthenticated-ai-gateway[0m\n\nNode.js v24.18.0",
    "minimal-viktor":
      '{"error":"[1m[31mUnauthenticated request to AI Gateway.[0m\\n\\n' +
      'To authenticate, set the AI_GATEWAY_API_KEY environment variable with your API key.\\n"}',
    "pr-summary-agent":
      "— agent finished —\nInvalid API key · Fix external API key\n(0 in / 0 out, $0.0000)\n" +
      "/home/runner/work/digital-twins/digital-twins/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:108",
  };
  for (const [name, output] of Object.entries(realCiOutput)) {
    const v = classifyLaunch({ output, stillRunningAtSettle: false, exitCode: 1 });
    check(`real CI output for ${name} classifies as reached`, v.status, "reached");
  }
}

// ── a swallowed outbound failure that still exits 0 is a FAIL, not reached ──
//
// The signature alone must not buy a pass: an example that hits the dead twin,
// logs it, and exits clean has done nothing and reported success. This is the
// shape `minimal-viktor-langgraph` had, and it only red-lined because its
// index.ts sets a non-zero exit code.
{
  const v = classifyLaunch({
    output: '{"error":"list_collaborators acme/api failed: fetch failed"}',
    stillRunningAtSettle: false,
    exitCode: 0,
  });
  check("a benign signature with exit 0 is a fail, not reached", v.status, "fail");
  assert.match(v.reason, /swallowed/);
}

// ── the benign list must not be broad enough to swallow a real defect ───────
//
// The one way this classifier degenerates back into "any exit is fine" is a
// signature loose enough to match ordinary failure prose. Each of these is
// output a BROKEN example plausibly produces, and none may read as reached.
{
  for (const output of [
    "",
    '{"task":"...","repo":"triage/summarize","decisions":[],"reports":[]}',
    "Error: something went wrong",
    "request failed",
    "TypeError: Cannot read properties of undefined (reading 'ref')",
    "AssertionError: expected 1 to equal 0",
    // This example's own Slack report for seed 04, which a bare /unauthorized/i
    // matched — an example excusing itself with its own healthy-path output.
    "merge blocked: author drive-by-dev is not an authorized collaborator https://github.com/o/r/pull/1",
    // A crash whose stack happens to have a 401st line: a bare /\b401\b/ read
    // this as an auth rejection.
    "TypeError: x is not a function\n    at run (/app/src/graph.ts:401:9)",
  ]) {
    check(
      `broken-example output is not excused: ${JSON.stringify(output.slice(0, 40))}`,
      classifyLaunch({ output, stillRunningAtSettle: false, exitCode: 0 }).status,
      "fail",
    );
  }
}

// ── the fail message has to tell the reader what to do about it ─────────────
{
  const v = classifyLaunch({ output: "unrecognized boom", stillRunningAtSettle: false, exitCode: 1 });
  assert.match(v.reason, /BENIGN_FAILURE_SIGNATURES/);
  check("an unrecognized failure names the list to extend", v.status, "fail");
}

// ── still running at the settle is the one real "did work" signal ──────────
{
  const v = classifyLaunch({ output: "· thinking… 2s", stillRunningAtSettle: true });
  check("still running at the settle is ok", v.status, "ok");
  assert.match(v.reason, new RegExp(String(SETTLE_MS)));
}

// ── break-on-purpose 4: zero examples discovered is a hard failure ─────────
{
  const emptyDir = mkdtempSync(join(tmpdir(), "smoke-examples-empty-"));
  try {
    check("an examples directory with nothing runnable discovers zero", discoverExamples(emptyDir), []);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

// ── discovery is a glob over `start` scripts, not a hand-kept list ─────────
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke-examples.mjs checks passed.");
