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
  const scheduled = [];
  for (const [file, lines] of workflowLines(root)) {
    let inOnBlock = false;
    // The indent of the FIRST key under `on:`, so a 4-space-indented block
    // matches as readily as a 2-space one, while anything DEEPER than it is a
    // key of some other trigger (a `workflow_call` input named `schedule`, say)
    // and still must not count.
    let keyIndent = null;
    for (const line of lines) {
      // `on` is a YAML 1.1 truthy keyword, so `"on":` is the standard yamllint
      // workaround for it and has to be recognised too.
      const start = /^(?:on|["']on["']):\s*(.*)$/.exec(line);
      if (start) {
        // Flow form on the same line — `on: {schedule: [{cron: "…"}]}`. The
        // previous revision set a flag here and then `continue`d past the only
        // line the key ever appears on, so that branch could not match at all.
        if (/\bschedule\b/.test(start[1])) {
          scheduled.push(file);
          break;
        }
        inOnBlock = start[1].trim() === "";
        continue;
      }
      if (!inOnBlock || line.trim() === "") continue;
      // Any other top-level (unindented) key ends the `on:` block.
      if (/^\S/.test(line)) {
        inOnBlock = false;
        continue;
      }
      const indent = /^\s*/.exec(line)[0].length;
      if (keyIndent === null) keyIndent = indent;
      // An inline value counts as well: `schedule: [{cron: "…"}]`.
      if (indent === keyIndent && /^\s*schedule:/.test(line)) {
        scheduled.push(file);
        break;
      }
    }
  }
  return scheduled.sort();
}

/**
 * Workflow file names carrying a `cron:` key anywhere.
 *
 * A SECOND, independent read of the same underlying fact, because "at least
 * one scheduled workflow exists" is a floor the three that exist today satisfy
 * forever. That makes it blind to the regression this file's header claims to
 * guard against, one workflow at a time: a parser that quietly stops
 * recognising some future workflow's YAML shape stays green. `cron:` and
 * `on: schedule:` are different strings read by different rules, so requiring
 * the two sets to be EQUAL makes either one drifting loud. Neither side is a
 * hand-kept list.
 */
export function findCronWorkflows(root) {
  const cron = [];
  for (const [file, lines] of workflowLines(root)) {
    if (lines.some((line) => /^\s*-?\s*cron:\s*\S/.test(line))) cron.push(file);
  }
  return cron.sort();
}

/**
 * Every `uses: ./.github/workflows/…` reference pointing at a file that is not
 * there.
 *
 * A job wired to the alarm with a typo'd path is a workflow GitHub refuses to
 * run: the alarm is present in the diff, present in review, and dead. Nothing
 * else in CI notices — actionlint would, but it is not wired into ci.yml, and
 * the reusable call itself is never exercised on a PR because every alarm job
 * is gated to schedule/workflow_dispatch by design.
 */
export function findBrokenLocalUses(root) {
  const broken = [];
  for (const [file, lines] of workflowLines(root)) {
    for (const line of lines) {
      const m = /^\s*uses:\s*["']?(\.\/[^"'\s]+)["']?\s*$/.exec(line);
      if (m && !existsSync(join(root, m[1]))) broken.push(`${file} -> ${m[1]}`);
    }
  }
  return broken.sort();
}

/** Every workflow file as `[name, comment-stripped lines]`. */
function workflowLines(root) {
  const dir = join(root, ".github", WORKFLOWS_DIR);
  if (!existsSync(dir)) {
    throw new Error(`no .github/workflows directory at ${dir}`);
  }
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => [
      file,
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        // Strip comments before matching: a workflow's own prose can contain
        // the literal strings "schedule:" and "cron:" — these files do.
        .map((raw) => raw.replace(/#.*$/, "")),
    ]);
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

  // The floor that can actually move. See findCronWorkflows().
  const cron = findCronWorkflows(root);
  const onlyScheduled = scheduled.filter((f) => !cron.includes(f));
  const onlyCron = cron.filter((f) => !scheduled.includes(f));
  if (onlyScheduled.length > 0 || onlyCron.length > 0) {
    throw new Error(
      "the two independent reads of 'which workflows are scheduled' disagree, " +
        "so one of them has stopped matching:\n" +
        `  on: schedule: but no cron: key -> ${onlyScheduled.join(", ") || "(none)"}\n` +
        `  cron: key but no on: schedule: -> ${onlyCron.join(", ") || "(none)"}\n` +
        "Fix the parser in list-scheduled-workflows.mjs, not this assertion — " +
        "a scheduled workflow it cannot see is a scheduled workflow the alarm " +
        "coverage check (F-1471) cannot see either.",
    );
  }

  const broken = findBrokenLocalUses(root);
  if (broken.length > 0) {
    throw new Error(
      "a workflow calls a local reusable workflow that does not exist, so " +
        "GitHub will refuse to run it and any alarm behind it is dead:\n  " +
        broken.join("\n  "),
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
