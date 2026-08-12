#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1230 — every workflow with a `schedule:` trigger needs a failure alarm
// (D5 · "every check runs somewhere that can fail"). The set of scheduled
// workflows is DERIVED from `.github/workflows/*.yml` rather than typed into
// a list anywhere: a hand-maintained list of "workflows with a schedule" is
// exactly the shape D5 names as the bug — it stays green while a thirteenth
// scheduled workflow lands uncovered. F-1471 (the follow-up that asserts
// "every scheduled workflow reaches the alarm" as a property, not an
// instance) reads this same derivation rather than re-parsing the tree with
// its own rules.
//
// Deliberately line-based, not a YAML parser: a workflow file's own comments
// can contain the literal string "schedule:" (this file does), so the search
// looks for a `schedule:` key at the top level of the `on:` block specifically
// — indented exactly two spaces under a bare `on:` line — rather than any
// occurrence of the word anywhere in the file. That is also why it skips
// commented-out lines (`#`) before matching.
//
// Usage: node scripts/ci/list-scheduled-workflows.mjs [--json]
// Exits 1 (naming the reason) if the workflows directory is missing or if
// literally nothing has a schedule trigger — a walk that finds zero scheduled
// workflows when `repo-policy.yml` and `secret-scan.yml` have carried a weekly
// cron for a long time, and `release-alarm.yml` a daily one, is a parser that
// has silently stopped matching, not a true fact about the tree; an alarm
// covering zero workflows passes forever.

import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = "workflows";

/**
 * Returns the sorted list of `.github/workflows/*.yml` (or `.yaml`) file
 * names that declare a top-level `on: schedule:` trigger.
 */
export function findScheduledWorkflows(root) {
  const dir = join(root, ".github", WORKFLOWS_DIR);
  if (!existsSync(dir)) {
    throw new Error(`no .github/workflows directory at ${dir}`);
  }
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const scheduled = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const lines = text.split("\n");
    let inOnBlock = false;
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, ""); // strip trailing comments before matching
      if (/^on:\s*$/.test(line) || /^on:\s*\{/.test(line)) {
        inOnBlock = true;
        continue;
      }
      if (inOnBlock) {
        // Any other top-level (unindented) key ends the `on:` block.
        if (/^\S/.test(line) && line.trim() !== "") {
          inOnBlock = false;
          continue;
        }
        if (/^\s{2}schedule:\s*$/.test(line)) {
          scheduled.push(file);
          break;
        }
      }
    }
  }
  return scheduled.sort();
}

export function main(argv = process.argv.slice(2)) {
  const root = resolve(HERE, "../..");
  const scheduled = findScheduledWorkflows(root);

  if (scheduled.length === 0) {
    throw new Error(
      "found zero workflows with a schedule: trigger — this repo has had at " +
        "least one since #300, so this is a parser regression, not a true fact " +
        "about the tree. Refusing to report a vacuous green.",
    );
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(scheduled));
  } else {
    console.log(`${scheduled.length} workflow(s) with a schedule: trigger:`);
    for (const f of scheduled) console.log(`  - .github/workflows/${f}`);
  }
  return scheduled;
}

// NOT `import.meta.main` (Node 24.2+; root `engines` allows >=24, so on
// 24.0/24.1 it is `undefined` and this guard would be false, exiting 0 having
// listed nothing). Realpath'd on BOTH sides so a symlinked checkout still
// matches; a guard that looks like it should have fired but did not throws
// rather than silently running nothing.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(
    `list-scheduled-workflows.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having listed nothing`,
  );
}

if (invokedDirectly) main();
