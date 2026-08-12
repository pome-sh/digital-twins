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

// ── benign network/auth failure is a named SKIP, never a pass ──────────────
{
  const v = classifyLaunch({
    output: "TypeError: fetch failed\n  ECONNREFUSED 127.0.0.1:59321",
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("connection refused before settle is a skip, not an ok", v.status, "skip");
  assert.match(v.reason, /connection refused/);
}
{
  const v = classifyLaunch({
    output: "Unauthenticated request to AI Gateway.",
    stillRunningAtSettle: false,
    exitCode: 1,
  });
  check("AI Gateway auth rejection before settle is a skip", v.status, "skip");
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
