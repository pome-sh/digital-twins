// SPDX-License-Identifier: Apache-2.0
//
// One harness for every rule's case table. A case runs the REAL runner against the
// REAL rule, not the predicate in-process: the interesting failure is a rule that
// stopped being reached.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../lint.mjs");

export function fixtureTree(files, prefix = "lint-rule-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

export function runRule(ruleName, files, { flags = [] } = {}) {
  const root = fixtureTree(files, `${ruleName}-`);
  const result = spawnSync(process.execPath, [RUNNER, ruleName, "--root", root, ...flags], {
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, root };
}

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
