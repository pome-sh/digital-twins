#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The repo's one lint runner.
//
// One runner owns traversal (`scripts/lint/context.mjs`), the report format and
// the exit code, so a rule is a declaration plus a predicate. A rule per
// executable means a tree walk, a formatter, an entry guard, an npm script and a
// CI step per rule — four places to touch to add one, which is why rules that
// should exist would not.
//
// Usage:
//   node scripts/lint.mjs                  every rule
//   node scripts/lint.mjs parent-vocab     one rule (local iteration)
//   node scripts/lint.mjs --list           what rules exist
//   node scripts/lint.mjs --offline        skip rules needing node_modules
//   node scripts/lint.mjs --root <dir>     lint a tree that is not this repo
//   node scripts/lint.mjs --verbose        rules that have extra detail print it

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createContext } from "./lint/context.mjs";
import { RULES } from "./lint/rules.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "lint/rules");

/**
 * Run `rules` against `root` and return one result per rule. A rule reports by
 * returning violations; a rule that cannot find its subject at all throws, and
 * that is a failure too — a gate that shrugs when its corpus went missing
 * prints the same thing as a gate whose corpus is clean.
 *
 * @param {{ root?: string, only?: string[], offline?: boolean, verbose?: boolean }} options
 */
export async function runRules({ root = REPO_ROOT, only = [], offline = false, verbose = false } = {}) {
  const selected = selectRules(only);
  const ctx = createContext({ root, verbose });
  const results = [];

  for (const rule of selected) {
    if (offline && rule.needsInstall) {
      // Naming a rule AND passing --offline is a contradiction: the run would
      // print a pass having checked nothing at all. Skipping is only honest when
      // the caller asked for everything.
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
      // `await`: the rules that parse TypeScript are deferred behind a dynamic
      // import, so their `check` is async. Every other rule's is sync and
      // `await` is a no-op on it.
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

/**
 * Every rule module on disk must be in the registry.
 *
 * The registry is a hand-written list of static imports, which is what lets
 * `knip` follow it — but it also means deleting one import line silently removes
 * a rule from enforcement. Nothing else would notice: the case-table runner
 * iterates the registry rather than the directory, so the orphaned table stops
 * running too, and knip counts every file under `scripts/lint/` as an entry
 * point. So the runner checks the directory against the registry on every run.
 */
export function findUnregisteredRules(rulesDir = RULES_DIR) {
  const registered = new Set(RULES.map((rule) => `${rule.name}.mjs`));
  return readdirSync(rulesDir)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .filter((name) => !registered.has(name))
    .sort();
}

/**
 * The other direction: a case table whose rule is not in the registry.
 *
 * `runRuleTests` iterates the registry, so such a table is never run — it reads
 * as coverage from the directory listing while asserting nothing. Cheap to check
 * and the counterpart to the guarantee above, so the invariant is symmetric:
 * every rule has a table, and every table has a rule.
 */
export function findOrphanCaseTables(rulesDir = RULES_DIR) {
  const registered = new Set(RULES.map((rule) => `${rule.name}.test.mjs`));
  return readdirSync(rulesDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => !registered.has(name))
    .sort();
}

/** The rules named in `only`, or all of them. An unknown name is a failure, not a silent no-op. */
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

/** True when every result passed. Printing is the caller's job. */
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

  // Never silent: a rule that did not run has to say so, or the summary line
  // reads as coverage the run does not have.
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

/**
 * Run each selected rule's case table — `scripts/lint/rules/<name>.test.mjs`,
 * found by convention rather than listed, so a new rule's table is picked up
 * with no second edit.
 *
 * A rule with NO table is reported, not skipped silently: a rule nobody has
 * proved can go red is a rule that may already have stopped going red.
 */
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

// Realpath'd on both sides, never a bare `import.meta.main` (undefined before
// Node 24.2, which root `engines: >=24` allows) and never a basename compare
// (satisfied by any file of that name anywhere on disk). Node resolves symlinks
// before deriving `import.meta.url`, so an un-realpath'd compare falls false
// through a symlinked checkout — a `git worktree`, or macOS's symlinked
// `/tmp` — and the runner exits 0 having linted nothing. A guard miss while
// invoked as this file throws rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("lint.mjs")) {
  throw new Error(`lint.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  // A usage error (unknown rule, contradictory flags) is a failed lint run, not a
  // crash report: print the sentence and exit 1.
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

  // Before anything else: a rule module that never made it into the registry is
  // a rule that does not run, and every other check here would stay green.
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
