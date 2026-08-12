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

import {
  SETTLE_MS,
  classifyLaunch,
  discoverExamples,
  assertAliveFloor,
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

// ── F-1486: the credentialed leg's floor — zero alive is a hard failure ────
{
  const zero = assertAliveFloor({ live: true, okCount: 0, total: 8 });
  check("zero alive on the live leg fails the floor", zero.ok, false);
  assert.match(zero.message, /0 of 8/);
  assert.match(zero.message, />= 1/);

  const one = assertAliveFloor({ live: true, okCount: 1, total: 8 });
  check(">= 1 alive on the live leg meets the floor", one.ok, true);

  const many = assertAliveFloor({ live: true, okCount: 8, total: 8 });
  check("every example alive still meets the floor", many.ok, true);

  // The floor must never apply to the uncredentialed (PR) leg — that leg's
  // permanent steady state is 0 alive, and this floor is not the mechanism
  // that would make it red for that.
  const notLive = assertAliveFloor({ live: false, okCount: 0, total: 8 });
  check("the floor is a no-op when not on the live leg", notLive.ok, true);
  check("a no-op floor carries no message", notLive.message, null);
}

// ── F-1486: an absent credential on the live leg must be named, not silent ─
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
  // GitHub Actions substitutes an UNSET secret as the empty string, so the
  // empty case is the one that actually happens in production, not a curiosity.
  check(
    "an empty-string secret is named as absent, not accepted",
    missingLiveEnv({ ANTHROPIC_API_KEY: "", POME_AUTH_TOKEN: "" }).sort(),
    [...LIVE_REQUIRED_ENV].sort(),
  );
  // Truthy but blank — a space or newline pasted into the secret box
  // (F-1187/F-1184's blank-in-Infisical shape). Untrimmed, this sails through
  // and the leg launches every example with a whitespace API key.
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

// ── F-1486: an unrecognised SMOKE_EXAMPLES_LIVE must ERROR, never mean "PR leg"
// A flag typo'd to `true` silently reverts to the uncredentialed leg: dead
// loopback ports, no credential check, no floor, exit 0. That is a green
// nightly proving nothing — this ticket's own subject, one character away.
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

// ── F-1486: the LIVE leg must still hand every example a task ───────────────
// Four of the eight `requiredEnv("POME_TASK")`. The first cut of the live leg
// overlaid nothing at all, so those four died on `Error: POME_TASK is required`
// and were classified FAIL ("returned without evidence it did any real work") —
// the nightly would have redded 4 of 8 on its first run for an unset env var.
{
  const realWiring = {
    ANTHROPIC_API_KEY: "sk-ant-real",
    POME_AUTH_TOKEN: "real-jwt",
    POME_GITHUB_MCP_URL: "http://127.0.0.1:3333/s/standalone/mcp",
    POME_PREFLIGHT: "1",
  };

  const live = launchEnv(realWiring, true);
  assert.ok(live.POME_TASK?.trim(), "the LIVE leg must supply a non-blank POME_TASK");
  // minimal-viktor's default alibaba/* slug is reachable ONLY via the AI
  // Gateway; on the credentialed leg (no fake gateway key) it throws before any
  // outbound call. The leg must pin a slug the ONE provisioned secret can serve.
  assert.match(
    live.VIKTOR_MODEL ?? "",
    /^anthropic\//,
    "the LIVE leg must pin an anthropic/* model slug so ANTHROPIC_API_KEY alone suffices",
  );
  check(
    "the LIVE leg does not fake an AI_GATEWAY_API_KEY",
    live.AI_GATEWAY_API_KEY,
    undefined,
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
  check("the LIVE leg keeps the real model key", live.ANTHROPIC_API_KEY, "sk-ant-real");
  check("the LIVE leg never re-enables POME_PREFLIGHT", live.POME_PREFLIGHT, undefined);
  // The whole point of the leg: no dead loopback port may be overlaid.
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

  // The PR leg is unchanged: the dead wiring overlay still wins outright.
  const pr = launchEnv(realWiring, false);
  check("the PR leg still overlays the dead loopback port", pr.POME_GITHUB_MCP_URL, "http://127.0.0.1:59321/s/smoke/mcp");
  check("the PR leg still overlays the invalid model key", pr.ANTHROPIC_API_KEY, "sk-ant-smoke-invalid");
  // The PR leg's fake gateway key is what lets alibaba/* resolve and then fail
  // at the outbound call (REACHED-OUTBOUND). Removing it would red that leg.
  check("the PR leg still overlays the fake gateway key", pr.AI_GATEWAY_API_KEY, "smoke-invalid");
  check("the PR leg does not pin a model slug", pr.VIKTOR_MODEL, undefined);
  assert.ok(pr.POME_TASK?.trim(), "the PR leg must supply a non-blank POME_TASK");
  check("the PR leg never re-enables POME_PREFLIGHT", pr.POME_PREFLIGHT, undefined);
}

// ── F-1486: the fast-correct-completion edge must be named in the failure ───
// OK is "still alive at the settle", so on the credentialed leg a correct-but-
// fast example exits 0 inside the settle and lands on FAIL. The verdict is
// acceptable; a message insisting the example is broken is not, because the
// first real nightly red would be undiagnosable.
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

  // Off the live leg the note must NOT appear — the PR leg's exit-0 examples
  // really are do-nothing exits, and F-1478's message is the right one there.
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
  // A non-zero exit is a crash on either leg; the fast-completion note would be
  // misleading there, so it must not appear.
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke-examples.mjs checks passed.");
