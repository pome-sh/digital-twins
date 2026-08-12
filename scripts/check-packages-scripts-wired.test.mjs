#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-packages-scripts-wired.mjs` (F-1472).
//
// The motivating bug (F-1354) was a `packages/*` script named like a check
// that sat unreachable for weeks with no verdict. The thing most worth
// proving here is that this gate CAN go red on that exact shape — a fresh
// `check:foo` with no caller — and that it can also go GREEN correctly: on a
// script that IS reached, and on a script that is deliberately exempt with
// its reason living in the file it invokes rather than in a list here.
//
// Each case builds a throwaway tree (a `packages/<name>/package.json`, an
// optional `.github/workflows/ci.yml`, and any script files the package.json
// commands name) and runs the real script against it via a different cwd —
// same pattern as check-twin-chunk-laziness.test.mjs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-packages-scripts-wired.mjs");

function write(root, relPath, contents) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), "scripts-wired-"));
  for (const [relPath, contents] of Object.entries(files)) write(root, relPath, contents);
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

let failures = 0;
function check(name, files, { expect, contains }) {
  const { code, out } = runAgainst(files);
  const got = code === 0 ? "green" : "red";
  const problems = [];
  if (got !== expect) problems.push(`expected ${expect}, got ${got}`);
  if (contains && !out.includes(contains)) problems.push(`output missing ${JSON.stringify(contains)}`);
  if (problems.length > 0) {
    failures += 1;
    console.error(`✗ ${name}\n  ${problems.join("\n  ")}\n${out.replace(/^/gm, "    ")}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const pkgJson = (name, scripts) => JSON.stringify({ name, scripts });

// Case 1: a vocab-matching script reached by a workflow line in the exact
// shape every real wired check in this repo uses. Must stay green.
check(
  "wired check:foo passes",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run check:foo -w @pome-sh/alpha\n",
  },
  { expect: "green" }
);

// Case 2 (the "do" in the ticket's "done when"): an unreferenced check:foo
// must red the gate BY NAME.
check(
  "unwired check:foo reds, naming it",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

// Case 3: exemption reason lives in the script the command invokes, never in
// a list here. Reading it must clear the red and print the reason, not
// silently pass with no trace.
check(
  "unwired script with an inline pome:unwired-ok exemption passes and prints the reason",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "validate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok: manual dev tool, needs a live credential CI lacks\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "manual dev tool, needs a live credential CI lacks" }
);

// Case 4: a script name outside the check vocabulary (no colon-prefixed
// validate/check/lint/gate/test/assert) is out of scope even unreferenced —
// this is the ticket's own boundary (dev-utility/interactive scripts are not
// checks), not a gap.
check(
  "unwired non-vocabulary script (smoke) is not flagged",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { smoke: "node scripts/smoke.mjs" }),
    "packages/alpha/scripts/smoke.mjs": "console.log('ok');\n",
  },
  { expect: "green" }
);

// Case 5: a bare "test" (no colon) is the standard lifecycle script every
// package has, wired uniformly elsewhere — deliberately not this gate's
// vocabulary, so an unreferenced one must not red.
check(
  "unwired bare 'test' (no colon) is not flagged",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { test: "vitest run" }),
  },
  { expect: "green" }
);

// Case 6: a script invoked by a root aggregate (not a workflow) counts as
// wired too — the corpus includes root scripts/, not only workflow YAML.
check(
  "reached only from a root script (root aggregate) passes",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/aggregate.mjs": "// runs: npm run gate:foo -w @pome-sh/alpha\n",
  },
  { expect: "green" }
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll check-packages-scripts-wired cases passed.");
