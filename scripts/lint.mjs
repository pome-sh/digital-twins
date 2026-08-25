#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The one lint runner. It owns traversal, the report format and the exit code, so a
// rule is a declaration plus a predicate. A rule that cannot find its subject
// throws — a gate that shrugs when its corpus vanished prints the same as a clean one.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createContext } from "./lint/context.mjs";
import { RULES } from "./lint/rules.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "lint/rules");

export async function runRules({ root = REPO_ROOT, only = [], offline = false, verbose = false } = {}) {
  const selected = selectRules(only);
  const ctx = createContext({ root, verbose });
  const results = [];

  for (const rule of selected) {
    if (offline && rule.needsInstall) {
      if (only.length > 0) {
        throw new Error(
          `${rule.name} needs an installed node_modules, so --offline cannot run it. ` +
            `Drop one of the two: a named rule that --offline skips would exit 0 having checked nothing.`,
        );
      }
      results.push({ rule, skipped: "needs an installed node_modules" });
      continue;
    }
    try {
      const outcome = (await rule.check(ctx)) ?? {};
      results.push({
        rule,
        violations: outcome.violations ?? [],
        summary: outcome.summary,
        hint: outcome.hint,
        detail: outcome.detail,
      });
    } catch (err) {
      results.push({ rule, violations: [err.message], threw: true });
    }
  }
  return results;
}

export function findUnregisteredRules(rulesDir = RULES_DIR) {
  const registered = new Set(RULES.map((rule) => `${rule.name}.mjs`));
  return readdirSync(rulesDir)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .filter((name) => !registered.has(name))
    .sort();
}

export function findOrphanCaseTables(rulesDir = RULES_DIR) {
  const registered = new Set(RULES.map((rule) => `${rule.name}.test.mjs`));
  return readdirSync(rulesDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => !registered.has(name))
    .sort();
}

export function selectRules(only) {
  if (only.length === 0) return RULES;
  const byName = new Map(RULES.map((rule) => [rule.name, rule]));
  const unknown = only.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown lint rule(s): ${unknown.join(", ")}. Run \`node scripts/lint.mjs --list\` for the ${RULES.length} that exist.`,
    );
  }
  return only.map((name) => byName.get(name));
}

export function report(results, { verbose = false, log = console.log, error = console.error } = {}) {
  let failed = 0;
  const skipped = [];

  for (const result of results) {
    if (result.skipped) {
      skipped.push(result);
      continue;
    }
    if (result.violations.length === 0) {
      log(`  ✓ ${result.rule.name}${result.summary ? ` — ${result.summary}` : ""}`);
      if (verbose && result.detail) for (const line of result.detail) log(`      ${line}`);
      continue;
    }
    failed += 1;
    error(`  ✗ ${result.rule.name} — ${result.rule.describe}`);
    for (const violation of result.violations) {
      for (const line of String(violation).split("\n")) error(`      ${line}`);
    }
    if (result.hint) {
      error("");
      for (const line of result.hint.split("\n")) error(`      ${line}`);
    }
    error("");
  }

  for (const result of skipped) {
    log(`  – ${result.rule.name} — SKIPPED (${result.skipped})`);
  }

  const ran = results.length - skipped.length;
  if (failed > 0) {
    error(`lint FAILED — ${failed} of ${ran} rule(s) reported violations.`);
    return false;
  }
  log(`lint passed — ${ran} rule(s)${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}.`);
  return true;
}

export function runRuleTests({ only = [], offline = false } = {}) {
  let failed = 0;
  const untested = [];

  for (const rule of selectRules(only)) {
    if (offline && rule.needsInstall) {
      console.log(`  – ${rule.name} — SKIPPED (case table needs an installed node_modules)`);
      continue;
    }
    const testFile = join(RULES_DIR, `${rule.name}.test.mjs`);
    if (!existsSync(testFile)) {
      untested.push(rule.name);
      continue;
    }
    const result = spawnSync(process.execPath, [testFile], { stdio: "inherit" });
    if (result.status !== 0) failed += 1;
  }

  if (untested.length > 0) {
    console.error(
      `\nNo case table for ${untested.length} rule(s): ${untested.join(", ")}. A rule nobody has ` +
        `proved can go red is a rule that may already have stopped going red — add ` +
        `scripts/lint/rules/<name>.test.mjs.`,
    );
  }
  return failed === 0 && untested.length === 0;
}

function parseArgv(argv) {
  const only = [];
  let root = REPO_ROOT;
  let offline = false;
  let verbose = false;
  let list = false;
  let runTests = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") list = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--run-tests") runTests = true;
    else if (arg === "--root") root = resolve(argv[(i += 1)]);
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else only.push(arg);
  }
  return { only, root, offline, verbose, list, runTests };
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("lint.mjs")) {
  throw new Error(`lint.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

async function main(argv) {
  const { only, root, offline, verbose, list, runTests } = parseArgv(argv);

  if (list) {
    for (const rule of RULES) {
      console.log(`${rule.name.padEnd(22)}${rule.needsInstall ? "[needs install] " : ""}${rule.describe}`);
    }
    process.exit(0);
  }

  const unregistered = findUnregisteredRules();
  if (unregistered.length > 0) {
    console.error(
      `${unregistered.length} rule module(s) under scripts/lint/rules/ are not in scripts/lint/rules.mjs, ` +
        `so the runner never reaches them: ${unregistered.join(", ")}. Add the import, or delete the file.`,
    );
    process.exit(1);
  }
  const orphanTables = findOrphanCaseTables();
  if (orphanTables.length > 0) {
    console.error(
      `${orphanTables.length} case table(s) under scripts/lint/rules/ name no registered rule, so they ` +
        `never run: ${orphanTables.join(", ")}. Rename the table to match its rule, or delete it.`,
    );
    process.exit(1);
  }

  if (runTests) process.exit(runRuleTests({ only, offline }) ? 0 : 1);

  const results = await runRules({ root, only, offline, verbose });
  process.exit(report(results, { verbose }) ? 0 : 1);
}
