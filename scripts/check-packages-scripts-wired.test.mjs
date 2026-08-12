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

// Cases 25+ (F-1476): the cli/ extension. cli/ is a single workspace member
// at `cli/`, not a directory of many under `packages/*`, so it needs its own
// coverage — same mechanisms, different base path.

// Case 25: a cli/package.json script wired the standard way passes, exactly
// like a packages/* one.
check(
  "wired cli/package.json check passes",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "node scripts/foo.mjs" }),
    "cli/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run gate:foo -w @pome-sh/cli\n",
  },
  { expect: "green" }
);

// Case 26 (the ticket's own "do"): an unreferenced cli/ check reds by name —
// the exact break-on-purpose the PR verifies by hand against the real repo.
check(
  "unwired cli/package.json check reds, naming it",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "node scripts/foo.mjs" }),
    "cli/scripts/foo.mjs": "console.log('ok');\n",
  },
  { expect: "red", contains: '@pome-sh/cli "gate:foo"' }
);

// Case 27: cli/'s own exemption marker, read from the file the command
// invokes — same syntax as packages/*.
check(
  "unwired cli/package.json script with a marker passes",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "node scripts/foo.mjs" }),
    "cli/scripts/foo.mjs": "// pome:unwired-ok(gate:foo): manual dev tool\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "manual dev tool" }
);

// Case 28: `pome` (cli/'s own equivalent of npm's `start` — runs the built
// tarball, asserts nothing) must not be flagged, the same reasoning as `dev`/
// `start` in the shared lifecycle set.
check(
  "cli/package.json's 'pome' runtime alias is not flagged",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { pome: "node dist/src/cli/main.js" }),
  },
  { expect: "green" }
);

// Case 29 (F-1476's motivating find): a raw cli/scripts/ file declared by NO
// package.json script at all — make-unwired-fixture.mjs's exact shape — has
// no script name for the npm-run regex to find, so it reds by its own path.
check(
  "an orphan cli/scripts/ file invoked by no script and imported by nothing reds by path",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { build: "tsup" }),
    "cli/scripts/orphan.mjs": "console.log('nothing calls this');\n",
  },
  { expect: "red", contains: "cli/scripts/orphan.mjs" }
);

// Case 30: the same orphan file, marked with its own reason, passes — keyed
// by its relative path rather than a script name, since it has none.
check(
  "an orphan cli/scripts/ file with a pome:unwired-ok(<path>) marker passes",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { build: "tsup" }),
    "cli/scripts/orphan.mjs":
      "// pome:unwired-ok(scripts/orphan.mjs): spawned via a resolved path, not a literal invocation\nconsole.log('ok');\n",
  },
  { expect: "green", contains: "spawned via a resolved path" }
);

// Case 31: a file that IS the invoked file of a declared cli/package.json
// script — including a LIFECYCLE one, e.g. prepublishOnly — is covered by
// that script's own status and must not also be flagged as an orphan.
check(
  "a file invoked by a lifecycle script (prepublishOnly) is not treated as an orphan",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { prepublishOnly: "node scripts/assert.mjs" }),
    "cli/scripts/assert.mjs": "console.log('ok');\n",
  },
  { expect: "green" }
);

// Case 32: a file imported by a sibling script is a library module, covered
// by whatever imports it — it must not be flagged as its own orphan entry.
// If the importer itself were dead, THAT file is what should show up, which
// case 29 above already proves.
check(
  "a cli/scripts/ file imported by a sibling is not its own orphan entry",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", { "gate:foo": "tsx scripts/foo.ts" }),
    ".github/workflows/ci.yml": "run: npm run gate:foo -w @pome-sh/cli\n",
    "cli/scripts/foo.ts": 'import { helper } from "./lib.js";\nhelper();\n',
    "cli/scripts/lib.ts": "export function helper() {}\n",
  },
  { expect: "green" }
);

// Case 33: cli/'s own write/--check pair is covered by the SAME derivation
// packages/* pairs use (case 16) — no new code, just entries sharing one
// pkgDir in one combined array.
check(
  "cli/'s own write mode is covered by its wired --check sibling",
  {
    "packages/dummy/package.json": pkgJson("@pome-sh/dummy", {}),
    "cli/package.json": pkgJson("@pome-sh/cli", {
      "emit:foo": "node scripts/foo.mjs",
      "check:foo": "node scripts/foo.mjs --check",
    }),
    "cli/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run check:foo -w @pome-sh/cli\n",
  },
  { expect: "green", contains: "wired sibling runs with --check" }
);

// Case 34: no cli/ directory at all (every case above but this one) must not
// throw or otherwise misbehave — packages/*-only repos (and this suite's own
// fixtures for cases 1-24) stay green with zero cli/ entries.
check(
  "a repo with no cli/ directory is unaffected",
  {
    "packages/alpha/package.json": pkgJson("@pome-sh/alpha", { "check:foo": "node scripts/foo.mjs" }),
    "packages/alpha/scripts/foo.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "run: npm run check:foo -w @pome-sh/alpha\n",
  },
  { expect: "green" }
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll check-packages-scripts-wired cases passed.");
