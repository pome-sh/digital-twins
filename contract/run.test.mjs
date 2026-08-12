// SPDX-License-Identifier: Apache-2.0
//
// Regression for F-1353: contract/run.mjs must discover every *.test.mjs file
// under contract/ instead of hand-listing them. The three fixture-directory
// cases pin the discovery mechanism itself; the last case proves it against
// the real contract/ directory by recomputing the expectation from an
// independent readdir scan, so adding a new contract/*.test.mjs file later
// needs no edit here.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
