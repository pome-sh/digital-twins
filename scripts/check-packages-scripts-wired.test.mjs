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
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok(validate:foo): manual dev tool, needs a live credential CI lacks\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "manual dev tool, needs a live credential CI lacks" }
);

// Case 4 (the inversion): a script whose NAME matches no check prefix is in
// scope anyway. Under the original prefix vocabulary `smoke` was invisible,
// which is how three twins' smoke scripts and `verify:cloud-token` sat unrun.
// The partition is total: wired, lifecycle, or reasoned-about.
check(
  "unwired non-prefixed script (smoke) IS flagged — the vocabulary is not a prefix list",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { smoke: "node scripts/smoke.mjs" }),
    "packages/alpha/scripts/smoke.mjs": "console.log('ok');\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "smoke"' }
);

// Case 5: a bare "test" is an npm LIFECYCLE name — the one fixed set this
// gate carries, closed by npm rather than by us, wired uniformly elsewhere.
// An unreferenced one must not red.
check(
  "unwired bare 'test' (no colon) is not flagged",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { test: "vitest run" }),
  },
  { expect: "green" }
);

// Case 6: a script invoked by a root aggregate (not a workflow) counts as
// wired too — the corpus includes root scripts/, not only workflow YAML. The
// invocation has to be live CODE, not a comment about it (case 12).
check(
  "reached only from a root script (root aggregate) passes",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/aggregate.mjs": "execSync('npm run gate:foo -w @pome-sh/alpha');\n",
  },
  { expect: "green" }
);

// Case 7 (break-on-purpose): a marker with NO reason must be REJECTED. The
// first version used `/pome:unwired-ok:\s*(.+)/`, and `\s` matches a newline —
// so a bare marker consumed the line break and reported the NEXT LINE of the
// file as its justification. An exemption with no reason is exactly what the
// milestone forbids.
check(
  "a marker with no reason text is rejected, not satisfied by the next line",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "validate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok(validate:foo):\nimport { readFileSync } from 'node:fs';\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "validate:foo"' }
);

// Case 8 (break-on-purpose): whitespace-only reason, same rule.
check(
  "a marker with a whitespace-only reason is rejected",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "validate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "// pome:unwired-ok(validate:foo):   \nconst x = 1;\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "validate:foo"' }
);

// Case 9 (break-on-purpose): a marker in an UNRELATED file must not satisfy
// the exemption. `[\w./-]+` matches `..`, so before the containment check the
// first file token in a compound command could escape the package entirely and
// borrow a reason written about something else.
check(
  "a marker in another package's file does not exempt this script",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "validate:foo": "node ../beta/scripts/other.mjs && node scripts/foo.mjs",
    }),
    "packages/alpha/scripts/foo.mjs": "console.log('no marker here');\n",
    "packages/beta/scripts/other.mjs": "// pome:unwired-ok(validate:foo): beta's own good reason\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "validate:foo"' }
);

// Case 10 (break-on-purpose): a marker must name the script it exempts. Three
// files in this repo implement a write mode AND a wired `--check` verdict
// (fixture:mcp/gate:mcp-fixture, regenerate:/gate:mcp-tool-fixture,
// emit:/check:trace-contract). An unnamed marker for the write half would
// pre-authorise the check half going unwired — the original defect, granted in
// advance.
check(
  "a marker naming a DIFFERENT script does not exempt this one",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "fixture:mcp": "node scripts/adopt.mjs",
      "gate:mcp-fixture": "node scripts/adopt.mjs --check",
    }),
    "packages/alpha/scripts/adopt.mjs": "// pome:unwired-ok(fixture:mcp): write half; the verdict half is gate:mcp-fixture\n",
    ".github/workflows/ci.yml": "run: npm run fixture:mcp -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:mcp-fixture"' }
);

// Case 11 (break-on-purpose): this gate and its own regression suite are not
// wiring. Both sit inside the corpus they scan and both quote `npm run <x> -w
// <pkg>` strings; a gate that accepts its own prose as proof a check runs is
// the bug it exists to catch.
check(
  "the gate's own file is not corpus — its docstrings cannot wire anything",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/check-packages-scripts-wired.test.mjs": "// npm run check:foo -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

// Case 12 (break-on-purpose): commenting a check out is the commonest way one
// stops producing a verdict — "# disabled, flaky" — and a plain text scan of
// the corpus counted the dead line as proof it still ran.
check(
  "a commented-out CI invocation is NOT wiring",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "      # disabled, flaky: npm run gate:foo -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:foo"' }
);

// Case 13 (break-on-purpose): a longer script's real CI line must not certify
// a shorter prefix-named one. `\b` after `gate:mcp` matches inside
// `gate:mcp-fixture` because `-` is a non-word character, so the gate meant to
// catch F-1354's shape would have produced it.
check(
  "a prefix-named sibling is not wired by the longer script's line",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "gate:mcp": "node scripts/mcp.mjs",
      "gate:mcp-fixture": "node scripts/fixture.mjs",
    }),
    "packages/alpha/scripts/mcp.mjs": "console.log('ok');\n",
    "packages/alpha/scripts/fixture.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run gate:mcp-fixture -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:mcp"' }
);

// Case 14: the same guard on the PACKAGE side — a scoped-name prefix
// (`@pome-sh/twin-slack` vs `@pome-sh/twin-slack-legacy`) must not cross-wire.
check(
  "a prefix-named package is not wired by the longer package's line",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "gate:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run gate:foo -w @pome-sh/alpha-legacy\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "gate:foo"' }
);

// Case 15 (break-on-purpose): run from the wrong cwd. Returning [] made this
// print `OK — 0 scripts` and exit 0 — a gate asserting nothing, reported as a
// pass. contract/run.mjs throws on an empty discovery for the same reason.
check(
  "no packages/ directory is a hard failure, not a green 0-script scan",
  { "README.md": "not a repo root\n" },
  { expect: "red", contains: "must run from the repo root" }
);

// Case 16: a write mode whose wired sibling runs the same command plus
// `--check` is covered by derivation, not by a hand-written reason — the shape
// three real files here have (fixture:mcp/gate:mcp-fixture and friends).
// Case 10 above is the same pair with the wiring on the OTHER script, and must
// stay red: a wired write mode asserts nothing and cannot cover a verdict.
check(
  "a write mode whose file a wired sibling already runs needs no marker",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "fixture:mcp": "node scripts/adopt.mjs",
      "gate:mcp-fixture": "node scripts/adopt.mjs --check",
    }),
    "packages/alpha/scripts/adopt.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run gate:mcp-fixture -w @pome-sh/alpha\n",
  },
  { expect: "green", contains: "wired sibling runs with --check" }
);

// Case 17 (break-on-purpose): the superset rule must be SAME-PACKAGE.
// twin-gmail and twin-slack both declare `fixture:mcp = tsx
// scripts/adopt-upstream-mcp-fixture.ts` — one command string, two different
// files — so a flat command list let gmail's write half be certified by
// slack's file after gmail's own verdict line was deleted.
check(
  "another package's wired --check does not cover this package's write half",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "fixture:mcp": "node scripts/adopt.mjs" }),
    "packages/alpha/scripts/adopt.mjs": "console.log('ok');\n",
    "packages/beta/package.json": pkgJson("@pome-sh/beta", {
      "fixture:mcp": "node scripts/adopt.mjs",
      "gate:mcp-fixture": "node scripts/adopt.mjs --check",
    }),
    "packages/beta/scripts/adopt.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml":
      "        run: npm run gate:mcp-fixture -w @pome-sh/beta\n        run: npm run fixture:mcp -w @pome-sh/beta\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "fixture:mcp"' }
);

// Case 18 (break-on-purpose): the extra argv must be `--check`, not just MORE.
// `startsWith(cmd + " ")` let a wired watch-mode dev script certify a verdict.
check(
  "a wired sibling with --watch does not cover an unwired check",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", {
      "check:foo": "node scripts/foo.mjs",
      "dev:foo": "node scripts/foo.mjs --watch",
    }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run dev:foo -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

// Case 19 (break-on-purpose): a JSDoc line is not wiring. This repo's house
// style puts `Usage: npm run <script> -w <package>` in a script header, so a
// comment ABOUT running a check was counting as running it.
check(
  "a JSDoc ` *` line mentioning the command is NOT wiring",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    "scripts/other.mjs": "/**\n * Usage: npm run check:foo -w @pome-sh/alpha\n */\nexport const x = 1;\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

// Case 20 (break-on-purpose): `--` ends npm's own options, so in
// `npm run x -- -w pkg` the `-w` goes to the SCRIPT, npm selects no workspace,
// and the command runs in the root. Not wiring.
check(
  "a workspace flag after `--` is not wiring — npm selects no workspace",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "        run: npm run check:foo -- -w @pome-sh/alpha\n",
  },
  { expect: "red", contains: '@pome-sh/alpha "check:foo"' }
);

// Cases 21-24: the syntaxes npm really accepts must all read as wired. Only
// one spelling was accepted before, so a genuinely-wired check went red the
// first time someone reformatted its line — a false red pointing at the wrong
// thing. ci.yml's 180-char five-workspace fidelity:parity line is the
// candidate.
for (const [label, line] of [
  ["workspace before the script name", "        run: npm run -w @pome-sh/alpha check:foo\n"],
  ["--workspace= form", "        run: npm run check:foo --workspace=@pome-sh/alpha\n"],
  ["--workspace space form", "        run: npm run --workspace @pome-sh/alpha check:foo\n"],
  ["npm run-script", "        run: npm run-script check:foo -w @pome-sh/alpha\n"],
]) {
  check(
    `wired via ${label} counts as wired`,
    {
      "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
      "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
      ".github/workflows/ci.yml": line,
    },
    { expect: "green" }
  );
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll check-packages-scripts-wired cases passed.");
