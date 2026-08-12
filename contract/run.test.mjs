// SPDX-License-Identifier: Apache-2.0
//
// Regression for F-1353: contract/run.mjs must discover every *.test.mjs file
// under contract/ instead of hand-listing them. The three fixture-directory
// cases pin the discovery mechanism itself; the last case proves it against
// the real contract/ directory by recomputing the expectation from an
// independent readdir scan, so adding a new contract/*.test.mjs file later
// needs no edit here.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./run.mjs";

test("discovers every *.test.mjs file in a directory, ignoring non-test files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "contract-discovery-"));
  try {
    writeFileSync(path.join(dir, "b.test.mjs"), "");
    writeFileSync(path.join(dir, "a.test.mjs"), "");
    writeFileSync(path.join(dir, "helpers.mjs"), ""); // not a test file
    writeFileSync(path.join(dir, "notes.txt"), "");
    const found = discoverTestFiles(dir, new Set()).map((f) => path.basename(f));
    assert.deepEqual(found, ["a.test.mjs", "b.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("excludes names passed in the exclusion set (cli-start.test.mjs, by default)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "contract-discovery-"));
  try {
    writeFileSync(path.join(dir, "cli-start.test.mjs"), "");
    writeFileSync(path.join(dir, "z.test.mjs"), "");
    const found = discoverTestFiles(dir).map((f) => path.basename(f));
    assert.deepEqual(found, ["z.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file added to contract/ is picked up with no hand edit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "contract-discovery-"));
  try {
    writeFileSync(path.join(dir, "existing.test.mjs"), "");
    const before = discoverTestFiles(dir, new Set()).map((f) => path.basename(f));
    assert.deepEqual(before, ["existing.test.mjs"]);
    writeFileSync(path.join(dir, "brand-new.test.mjs"), "");
    const after = discoverTestFiles(dir, new Set()).map((f) => path.basename(f));
    assert.deepEqual(after, ["brand-new.test.mjs", "existing.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real contract/ directory matches an independent readdir scan, minus the documented CLI exception", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const expected = readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs") && f !== "cli-start.test.mjs")
    .sort();
  const found = discoverTestFiles().map((f) => path.basename(f));
  assert.deepEqual(found, expected);
});

// ── the property, not the instances (D5) ────────────────────────────────────
// The two cases below are why `EXCLUDED_FROM_DISCOVERY` having one entry is
// not just a shorter hand-maintained list. The first makes the union of
// (discovered by run.mjs) ∪ (invoked by a named ci.yml step) provably TOTAL
// over contract/*.test.mjs, so a second cli-dependent contract test cannot be
// excluded from the runner without a workflow step that runs it — the drift
// F-1353 found, where two lists each assumed the other covered the file. The
// second reds if the runner's `node --test` argv goes back to literal paths,
// which the discoverTestFiles() cases above would stay green through: they
// test the helper, not what the pipeline actually invokes.

const CONTRACT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CONTRACT_DIR, "..");

test("every contract/*.test.mjs file is run by the runner or by a named ci.yml step", () => {
  // Comment lines dropped: ci.yml's F-1353 note NAMES cli-start.test.mjs in
  // prose, and a comment mentioning a file is not a step that runs it. Then
  // whole-token matching, not a RegExp built from a filename — a path is not a
  // pattern, and `foo.test.mjs` as a regex also matches `fooXtest.mjs`.
  const invokedByWorkflow = new Set(
    readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.includes("node --test"))
      .flatMap((line) => line.trim().split(/\s+/))
  );
  const discovered = new Set(discoverTestFiles().map((f) => path.basename(f)));
  const uncovered = readdirSync(CONTRACT_DIR)
    .filter((f) => f.endsWith(".test.mjs") && !discovered.has(f))
    .filter((f) => !invokedByWorkflow.has(`contract/${f}`));
  assert.deepEqual(
    uncovered,
    [],
    `contract test file(s) run by neither contract/run.mjs's discovery nor a ci.yml step: ${uncovered.join(", ")}`
  );
});

test("run.mjs invokes the discovered list, never literal contract test paths", () => {
  // The exclusion set is the one place allowed to name a file, so cut it out
  // before scanning rather than allow-listing the name it happens to hold —
  // a widened exclusion set is the sibling test's red, not this one's.
  const source = readFileSync(path.join(CONTRACT_DIR, "run.mjs"), "utf8").replace(
    /new Set\(\[[^\]]*\]\)/g,
    "new Set([])"
  );
  // `\w` before the suffix so the `.endsWith(".test.mjs")` filter is not a hit.
  const offenders = source.match(/["'`][^"'`\n]*\w\.test\.mjs["'`]/g) ?? [];
  assert.deepEqual(
    offenders,
    [],
    `run.mjs hand-lists contract test path(s) instead of discovering them: ${offenders.join(", ")}`
  );
  assert.match(source, /discoverTestFiles\(\)/, "run.mjs builds its --test argv from discoverTestFiles()");
});
