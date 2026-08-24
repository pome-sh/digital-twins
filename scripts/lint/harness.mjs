// SPDX-License-Identifier: Apache-2.0
//
// The one test harness for lint rules.
//
// Every rule used to ship its own regression suite, and every one of those
// suites was the same forty lines: mkdtemp a throwaway tree, write a `files`
// map into it, `spawnSync` the real script with `cwd` pointed at it, compare the
// exit code against green/red, and keep a failure counter. Twenty copies of the
// scaffolding around a case table that was the only part that differed.
//
// A case runs the REAL runner against the REAL rule (`node scripts/lint.mjs
// <rule> --root <tmp>`), not an in-process call to the predicate. That is
// deliberate: the interesting failure is a rule that stops being reached, and an
// in-process call cannot see a rule missing from the registry or a runner that
// swallows a throw.
//
// Usage:
//
//   import { defineCases } from "../harness.mjs";
//
//   defineCases("parent-vocab", [
//     { name: "clean tree", files: { ... }, expect: "green" },
//     { name: "quoted key", files: { ... }, expect: "red", contains: "parent_id" },
//   ]);

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../lint.mjs");

/** Materialize a `{ relativePath: contents }` map into a fresh temp directory. */
export function fixtureTree(files, prefix = "lint-rule-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** Run one rule against a throwaway tree. Returns the exit code and all output. */
export function runRule(ruleName, files, { flags = [] } = {}) {
  const root = fixtureTree(files, `${ruleName}-`);
  const result = spawnSync(process.execPath, [RUNNER, ruleName, "--root", root, ...flags], {
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, root };
}

/**
 * Run a rule's case table and exit non-zero if any case disagrees.
 *
 * Each case is
 * `{ name, files, expect: "green" | "red", contains?, notContains?, flags? }`.
 *
 * `contains` is asserted on the combined output — a red case that reds for the
 * wrong reason is a rule that stopped checking what it claims, so the assertion
 * has to be on the message and not only on the exit code. `notContains` is its
 * inverse, for a case whose point is that a neighbouring file was NOT implicated.
 * Both take a string, a RegExp (for a line number or a count the message
 * interpolates), or an array of either.
 */
export function defineCases(ruleName, cases) {
  let failures = 0;

  for (const testCase of cases) {
    const { code, out } = runRule(ruleName, testCase.files, { flags: testCase.flags });
    const got = code === 0 ? "green" : "red";
    const problems = [];
    if (got !== testCase.expect) problems.push(`expected ${testCase.expect}, got ${got}`);
    for (const needle of [testCase.contains].flat().filter(Boolean)) {
      if (!matches(out, needle)) problems.push(`output does not match ${needle}`);
    }
    for (const needle of [testCase.notContains].flat().filter(Boolean)) {
      if (matches(out, needle)) problems.push(`output should not match ${needle}`);
    }
    if (problems.length > 0) {
      failures += 1;
      console.error(`✗ ${ruleName}: ${testCase.name}`);
      for (const problem of problems) console.error(`    ${problem}`);
      console.error(out.replace(/^/gm, "    "));
    } else {
      console.log(`✓ ${ruleName}: ${testCase.name}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${cases.length} ${ruleName} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n${cases.length} ${ruleName} case(s) passed.`);
}

function matches(output, needle) {
  return needle instanceof RegExp ? needle.test(output) : output.includes(needle);
}
