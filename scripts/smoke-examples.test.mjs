#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `smoke-examples.mjs`.
//
// The gap that undermines this gate's whole job: an exit inside SETTLE_MS
// reading as "OK", so an example that returned having done nothing looks
// identical to a healthy launch. `classifyLaunch()` is where that is decided,
// so this suite drives it directly with synthetic evidence rather than spawning
// all eight real examples (slow, network- and timing-dependent — the real
// launches are exercised by `npm run smoke:examples` itself in CI).
//
// Four break-on-purpose scenarios: exits 0 immediately with no evidence of
// work, exits 1 immediately with no recognized benign reason, a module-body TDZ
// (must never regress to a skip or a pass), and zero examples discovered.
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

// ── An outbound-call failure is its own named verdict, distinct from
// ok — but ONLY once the positive-evidence marker is present. The marker is
// what a real launch prints (either via @pome-sh/adapter-claude-sdk's query(),
// or the literal print each non-adapter example carries) immediately before
// its first outbound attempt, so these fixtures include it exactly as real
// captured output would.
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

// ── Fail-closed: no marker means no "reached", no matter how benign
// the crash text looks. This is the central acceptance bar — a
// pre-wiring crash whose message deliberately CONTAINS benign-looking text
// ("ECONNREFUSED", "401 invalid x-api-key") must still FAIL, because the
// marker (proof the example ever reached its outbound call site) never
// printed. Archaeology of the failure text alone is exactly what let a lost
// SDK race convert a real crash into a pass.
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

// ── The other direction: the marker is printed at the outbound call
// SITE, so a crash between that line and the syscall prints it first. Both of
// these were MEASURED on this branch (the adapter seam with an unresolvable
// `claude` binary; `gmail-retry-notify` with a malformed twin URL) and both
// FAILED under the old text classifier, so the marker alone must not convert
// them into passes — that is the same defect through the back door.
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

// ── Both of the SDK's racing error shapes give the SAME verdict once
// the marker is present. This is the exact nondeterminism at issue:
// `@anthropic-ai/claude-agent-sdk@0.3.221`'s query() picks between
// "Claude Code returned an error result: …" (lastErrorResultText won the
// race) and "Claude Code process exited with code N. stderr: …" (lost the
// race) for the identical underlying 401. Both must classify identically.
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

// ── the signature list is locked against REAL CI output, not invented text ──
//
// Every string below is copied verbatim from the `smoke:examples` job log of
// a real PR run (github.com/pome-sh/digital-twins/actions/runs/31614212888),
// with OUTBOUND_MARKER prepended — a real launch prints it before
// any of this text. This is the case that matters: the list decides whether
// the gate is usable in the only environment that gates anything, and a
// tightened pattern that no longer matches what CI actually prints reds all
// eight examples at once. If a dependency changes its error wording, this
// fails here — cheaply, naming the example — instead of in a CI run that reds
// everything.
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
    // The status alone is decided by the marker, so asserting only that would
    // pass with BENIGN_FAILURE_SIGNATURES emptied — a vacuous version of the
    // claim in this block's header. The REASON is what the signature list
    // still owns, so assert a class was actually recognized: a pattern
    // tightened past what CI prints reds here, cheaply, naming the example.
    assert.match(
      v.reason,
      /an outbound call failed \(.+\)/,
      `${name}: no BENIGN_FAILURE_SIGNATURES entry recognized this real CI output`,
    );
  }
}

// ── a swallowed outbound failure that still exits 0 is a FAIL, not reached ──
//
// The marker alone must not buy a pass on the PR leg: SMOKE_ENV's dead wiring
// cannot succeed, so an example that reaches its marker, hits the dead twin,
// logs it, and exits clean has swallowed the failure and reported success.
// This is the shape `minimal-viktor-langgraph` had, and it only red-lined
// because its index.ts sets a non-zero exit code.
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

// ── the benign list must not be broad enough to swallow a real defect, even
// with the marker present — matchBenignFailure() is descriptive only now, it
// never gates a "reached" verdict on its own (the marker plus a non-zero exit
// does). These fixtures omit the marker, so a broken example's ordinary
// failure prose (which was never proof of anything) still reds.
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

// ── the fail message has to tell the reader what to do about it ───────────
{
  const v = classifyLaunch({ output: "unrecognized boom", stillRunningAtSettle: false, exitCode: 1 });
  assert.match(v.reason, new RegExp(OUTBOUND_MARKER));
  check("an unrecognized failure names the marker it never saw", v.status, "fail");
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

// ── The credentialed leg's floor — zero alive is a hard failure ────────────
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

// ── An absent credential on the live leg must be named, not silent ─────────
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
  // (the blank-in-Infisical shape). Untrimmed, this sails through
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

// ── An unrecognised SMOKE_EXAMPLES_LIVE must ERROR, never mean "PR leg"
// A flag typo'd to `true` silently reverts to the uncredentialed leg: dead
// loopback ports, no credential check, no floor, exit 0. That is a green
// nightly proving nothing, one character away.
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

// ── The LIVE leg must still hand every example a task ───────────────────────
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
  // Compared to a boolean, never passed as a value: check() prints `got` on
  // failure, and handing it anything read off a *_API_KEY property is
  // clear-text logging of sensitive information (js/clear-text-logging), which
  // CodeQL flags high even when the value is this file's own fake literal.
  check("the LIVE leg keeps the real model key", live.ANTHROPIC_API_KEY === "sk-ant-real", true);
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
  check(
    "the PR leg still overlays the invalid model key",
    pr.ANTHROPIC_API_KEY === "sk-ant-smoke-invalid",
    true,
  );
  // The PR leg's fake gateway key is what lets alibaba/* resolve and then fail
  // at the outbound call (REACHED-OUTBOUND). Removing it would red that leg.
  check(
    "the PR leg still overlays the fake gateway key",
    pr.AI_GATEWAY_API_KEY === "smoke-invalid",
    true,
  );
  check("the PR leg does not pin a model slug", pr.VIKTOR_MODEL, undefined);
  assert.ok(pr.POME_TASK?.trim(), "the PR leg must supply a non-blank POME_TASK");
  check("the PR leg never re-enables POME_PREFLIGHT", pr.POME_PREFLIGHT, undefined);
  // MARK_OUTBOUND_ENV is neither a credential nor twin/model wiring —
  // it applies on BOTH legs unconditionally, or an example launched on
  // whichever leg forgot it never prints OUTBOUND_MARKER and can never be
  // classified as reached.
  check("the LIVE leg tells examples to emit the marker", live[MARK_OUTBOUND_ENV], "1");
  check("the PR leg tells examples to emit the marker too", pr[MARK_OUTBOUND_ENV], "1");
}

// ── The fast-correct-completion edge must be named in the failure ───────────
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
  // really are do-nothing exits, and the do-nothing message is right there.
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

// ── The counted-numerator property ──────────────────────────────────────────
// The shape this pins: the summary reads "7 of 8" and names seven, and nothing
// said the eighth (`pr-summary-agent`) had gone MISSING rather than FAILED —
// classifyLaunch()'s three named outcomes (ok/reached/fail) are worthless if
// main()'s loop can silently drop an example before it ever reaches them.
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

  // The exact shape: one discovered example silently produces no
  // verdict at all, and the summary must red naming it — not "failed",
  // "missing".
  const oneVanished = assertReportedCount(all8, all8.filter((n) => n !== "pr-summary-agent"));
  check("one missing example fails the count assertion", oneVanished.ok, false);
  assert.match(oneVanished.message, /pr-summary-agent/);
  assert.match(oneVanished.message, /1 of 8/);
  // Names it as absent from every existing bucket, never as belonging to one.
  assert.match(oneVanished.message, /neither OK, REACHED-OUTBOUND, nor FAILED/);

  // Compares NAMES, not just lengths: dropping one example and (by some other
  // bug) reporting an unrelated name twice must still be caught, because the
  // two lengths would otherwise net out even.
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

  // Zero discovered, zero reported is vacuously fine — discoverExamples()'s
  // own zero-examples case is a separate hard failure (break-on-purpose 4
  // above), not this assertion's job to catch.
  check("nothing discovered, nothing reported is a pass", assertReportedCount([], []).ok, true);
}

// ── The marker guard reds when a new example has no route to the
// marker at all — asserting the PROPERTY (does this example's source or its
// @pome-sh/adapter-claude-sdk dependency give it a way to print
// OUTBOUND_MARKER?), never a hand-kept list of the four that need it directly.
{
  const dir = mkdtempSync(join(tmpdir(), "smoke-examples-marker-"));
  try {
    // Covered via the shared seam: depends on @pome-sh/adapter-claude-sdk, no
    // literal marker in its own source required.
    mkdirSync(join(dir, "via-adapter", "src"), { recursive: true });
    writeFileSync(
      join(dir, "via-adapter", "package.json"),
      JSON.stringify({
        scripts: { start: "tsx src/index.ts" },
        dependencies: { "@pome-sh/adapter-claude-sdk": "file:../../packages/adapter-claude-sdk" },
      }),
    );
    writeFileSync(join(dir, "via-adapter", "src", "index.ts"), "import { query } from '@pome-sh/adapter-claude-sdk';\n");

    // Covered directly: no @pome-sh dependency, but its own source contains
    // the literal marker.
    mkdirSync(join(dir, "via-literal", "src"), { recursive: true });
    writeFileSync(
      join(dir, "via-literal", "package.json"),
      JSON.stringify({ scripts: { start: "tsx src/index.ts" } }),
    );
    writeFileSync(
      join(dir, "via-literal", "src", "index.ts"),
      `if (process.env.${MARK_OUTBOUND_ENV} === "1") console.error("${OUTBOUND_MARKER}");\n`,
    );

    // NOT covered: no @pome-sh dependency and no literal marker anywhere in
    // its source — exactly the ninth-example-that-forgot-it shape.
    mkdirSync(join(dir, "forgot-it", "src"), { recursive: true });
    writeFileSync(
      join(dir, "forgot-it", "package.json"),
      JSON.stringify({ scripts: { start: "tsx src/index.ts" } }),
    );
    writeFileSync(join(dir, "forgot-it", "src", "index.ts"), "console.log('does real work, prints nothing marker-shaped');\n");

    // NOT covered: it DEPENDS on the adapter, but from the REGISTRY — a
    // published tarball cut before the marker existed prints nothing, which is
    // `agent-examples/support-triage`'s real shape (measured: zero occurrences of the
    // marker in its installed dist). A dependency-name-only check called this
    // covered while every run FAILED it.
    mkdirSync(join(dir, "registry-pinned", "src"), { recursive: true });
    writeFileSync(
      join(dir, "registry-pinned", "package.json"),
      JSON.stringify({
        scripts: { start: "tsx src/index.ts" },
        dependencies: { "@pome-sh/adapter-claude-sdk": "0.3.5" },
      }),
    );
    writeFileSync(join(dir, "registry-pinned", "src", "index.ts"), "import { query } from '@pome-sh/adapter-claude-sdk';\n");

    // NOT covered: the literal appears, but only as a MENTION in a comment —
    // coverage requires an emitting `console.error(...)` call.
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
    // Only the example actually missing it is named.
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

// ── The real agent-examples/ directory in THIS repo passes the guard ─────────────
// The synthetic fixtures above prove the guard's logic; this proves the
// guard actually holds against the tree it will run against in CI.
{
  const real = discoverExamples();
  const coverage = assertEveryExampleEmitsMarker(examplesDirForRepo(), real);
  check("every real discovered example has a route to the marker", coverage.ok, true);
}

function examplesDirForRepo() {
  // fileURLToPath, not `.pathname`: the latter stays percent-encoded, so a
  // checkout under a path with a space reds this on ENOENT for a reason that
  // has nothing to do with the property being asserted.
  return fileURLToPath(new URL("../agent-examples", import.meta.url));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke-examples.mjs checks passed.");
