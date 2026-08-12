#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for scripts/lint-no-bare-import-meta-main.mjs (F-1481).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverSourceFiles, findBareImportMetaMain, scanRepo } from "./lint-no-bare-import-meta-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}

// ── findBareImportMetaMain: every real shape must red ───────────────────────
// Formatting cannot hide it: a line break, parens, optional chaining, negation,
// or a destructure straight off `import.meta` (with or without a rename) all
// have to be caught, because these are exactly the forms a naive regex misses.
const REAL_SHAPES = {
  "bare member access": "if (import.meta.main) { run(); }",
  "wrapped in parens": "if ((import.meta.main)) { run(); }",
  "split across lines": "if (\n  import.meta\n    .main\n) { run(); }",
  "negated": "if (!import.meta.main) { skip(); }",
  "optional chaining": "if (import.meta?.main) { run(); }",
  "computed access": 'if (import.meta["main"]) { run(); }',
  "destructured, no rename": "const { main } = import.meta;\nif (main) run();",
  "destructured with rename": "const { main: isMain } = import.meta;\nif (isMain) run();",
  "assignment-expression destructure": "let main;\n({ main } = import.meta);",
};
for (const [label, source] of Object.entries(REAL_SHAPES)) {
  const hits = findBareImportMetaMain(source);
  assert(hits.length > 0, `a real import.meta.main reference is caught: ${label} (source: ${JSON.stringify(source)})`);
}

// ── the false positives a grep would produce, which parsing must not ────────
const FALSE_POSITIVES = {
  "line comment": "// import.meta.main\nconsole.log('ok');",
  "block comment": "/* uses import.meta.main historically */\nconsole.log('ok');",
  "string literal": "const s = 'import.meta.main';\nconsole.log(s);",
  "template literal": "const s = `guard is import.meta.main`;\nconsole.log(s);",
  "unrelated .main property": "const config = { main: true };\nif (config.main) run();",
  "import.meta without .main": "const url = import.meta.url;\nconsole.log(url);",
};
for (const [label, source] of Object.entries(FALSE_POSITIVES)) {
  const hits = findBareImportMetaMain(source);
  assert(hits.length === 0, `not a real reference, must not red: ${label} (got ${JSON.stringify(hits)})`);
}

// A file mixing a real reference with a comment/string mention of the same
// text must still be caught by the real one — the false-positive text must
// not somehow cancel the true positive, and vice versa.
{
  const mixed = "// import.meta.main is banned here\nif (import.meta.main) { run(); }\nconst s = 'import.meta.main';";
  const hits = findBareImportMetaMain(mixed);
  assert(hits.length === 1, `a real reference is caught even alongside comment/string mentions (got ${hits.length})`);
}

// ── discoverSourceFiles: a directory walk, not a hand-kept list ─────────────
{
  const dir = mkdtempSync(join(tmpdir(), "f1481-discover-"));
  try {
    mkdirSync(join(dir, "scripts", "nested"), { recursive: true });
    writeFileSync(join(dir, "scripts", "a.mjs"), "export const a = 1;\n");
    writeFileSync(join(dir, "scripts", "nested", "b.js"), "export const b = 1;\n");
    writeFileSync(join(dir, "scripts", "ignore.json"), "{}\n");
    // No contract/ directory at all — discovery must not throw on an absent root.
    const files = discoverSourceFiles(dir);
    assert(files.length === 2, `discovery walks nested directories and filters by extension (got ${files.length})`);
    assert(files.some((f) => f.endsWith("nested/b.js")), "discovery finds a file nested two levels down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Independent second derivation of the same file set, using `find` rather
// than the gate's own readdirSync walk. If discovery silently stopped
// recursing (or started skipping an extension) this comparison — not a
// hardcoded count — is what reds, so the floor moves with the tree instead of
// being satisfied forever by today's file count.
{
  const viaDiscovery = discoverSourceFiles(ROOT).sort();
  const viaFind = execFileSync(
    "find",
    ["scripts", "contract", "-type", "f", "(", "-name", "*.mjs", "-o", "-name", "*.js", ")"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((p) => join(ROOT, p))
    .sort();
  assert(
    viaDiscovery.length === viaFind.length && viaDiscovery.every((f, i) => f === viaFind[i]),
    `discoverSourceFiles agrees with an independently-derived file list ` +
      `(discovery: ${viaDiscovery.length}, find: ${viaFind.length})`
  );
}

// ── scanRepo: zero files discovered is a hard failure, not a silent pass ───
{
  const emptyDir = mkdtempSync(join(tmpdir(), "f1481-empty-"));
  try {
    let threw = false;
    try {
      scanRepo(emptyDir);
    } catch (err) {
      threw = true;
      assert(/zero files/.test(err.message), `the empty-scan error names the problem (got: ${err.message})`);
    }
    assert(threw, "pointing the scan at a tree with no scripts/ or contract/ throws rather than reporting a pass");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

// ── scanRepo: break-on-purpose against a scratch fixture ───────────────────
// This is the ticket's own break-on-purpose case, run as an assertion rather
// than by hand: add a bare guard to a scratch file under scripts/, and the
// scan must red naming that exact file — while a sibling file that only
// MENTIONS the string in a comment or a string literal must not.
{
  const dir = mkdtempSync(join(tmpdir(), "f1481-scratch-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "broken.mjs"),
      "// a scratch file that should never ship\nif (import.meta.main) { console.log('ran'); }\n"
    );
    writeFileSync(
      join(dir, "scripts", "clean.mjs"),
      "// mentions import.meta.main only in prose, and in a string: 'import.meta.main'\nconsole.log('fine');\n"
    );
    const { filesScanned, findings } = scanRepo(dir);
    assert(filesScanned === 2, `both scratch files are scanned (got ${filesScanned})`);
    assert(
      findings.length === 1 && findings[0].file === "scripts/broken.mjs",
      `the scan reds exactly the file with a real bare guard, naming it (got: ${JSON.stringify(findings)})`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the shipped repo is clean ────────────────────────────────────────────
// This is the regression that matters most: it is what would have caught
// scripts/probe-twin-endpoints.mjs shipping a bare `import.meta.main` guard,
// and it is what reds if the next file reintroduces the shape.
{
  const { filesScanned, findings } = scanRepo(ROOT);
  assert(filesScanned > 0, "the real scan covers at least one file");
  assert(
    findings.length === 0,
    `no bare import.meta.main anywhere under scripts/ or contract/ (got: ${JSON.stringify(findings)})`
  );
}

// ── the gate is actually wired into CI, under a failing shell mode ─────────
{
  const { readFileSync } = await import("node:fs");
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert(ci.includes("npm run lint:import-meta-main"), "ci.yml runs the repo-wide gate");
  assert(ci.includes("node scripts/lint-no-bare-import-meta-main.test.mjs"), "ci.yml runs the gate's own tests");
  assert(/set -euo pipefail/.test(ci), "the step block the gate lives in runs under a failing shell mode");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert(
    pkg.scripts["lint:import-meta-main"] === "node scripts/lint-no-bare-import-meta-main.mjs",
    "package.json declares lint:import-meta-main"
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("lint-no-bare-import-meta-main: all assertions passed.");
