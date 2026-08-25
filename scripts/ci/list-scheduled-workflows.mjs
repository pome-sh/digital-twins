#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The set of scheduled workflows, derived from .github/workflows/*.yml rather than
// listed. Two independent reads (`on: schedule:` and `cron:`) must agree, and zero
// discovered is a parser regression, not a fact about the tree.

import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = "workflows";

export function findScheduledWorkflows(root) {
  const scheduled = [];
  for (const [file, lines] of workflowLines(root)) {
    let inOnBlock = false;
    let keyIndent = null;
    for (const line of lines) {
      const start = /^(?:on|["']on["']):\s*(.*)$/.exec(line);
      if (start) {
        if (/\bschedule\b/.test(start[1])) {
          scheduled.push(file);
          break;
        }
        const inline = start[1].trim();
        const opens = (inline.match(/[{[]/g) ?? []).length;
        const closes = (inline.match(/[}\]]/g) ?? []).length;
        if (opens !== closes) {
          throw new Error(
            `${file}: an \`on:\` flow mapping that spans more than one line is not parsed by ` +
              "this derivation, so a `schedule:` trigger inside it would be invisible to it and " +
              "to the alarm-coverage check alike. Rewrite it in block form.",
          );
        }
        inOnBlock = inline === "";
        continue;
      }
      if (!inOnBlock || line.trim() === "") continue;
      if (/^\S/.test(line)) {
        inOnBlock = false;
        continue;
      }
      const indent = /^\s*/.exec(line)[0].length;
      if (keyIndent === null) keyIndent = indent;
      if (indent === keyIndent && /^\s*schedule:/.test(line)) {
        scheduled.push(file);
        break;
      }
    }
  }
  return scheduled.sort();
}

export function findCronWorkflows(root) {
  const cron = [];
  for (const [file, lines] of workflowLines(root)) {
    if (lines.some((line) => /(?:^|[\s,[{-])cron\s*:\s*\S/.test(line))) cron.push(file);
  }
  return cron.sort();
}

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

function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

export function workflowLines(root) {
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
        .map((raw) => stripComment(raw.replace(/\r$/, ""))),
    ]);
}

export function main(argv = process.argv.slice(2)) {
  const root = resolve(HERE, "../..");
  const scheduled = findScheduledWorkflows(root);

  if (scheduled.length === 0) {
    throw new Error(
      "found zero workflows with a schedule: trigger — this repo has had at " +
        "least one, so this is a parser regression, not a true fact " +
        "about the tree. Refusing to report a vacuous green.",
    );
  }

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
        "coverage check cannot see either.",
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

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(
    `list-scheduled-workflows.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having listed nothing`,
  );
}

if (invokedDirectly) main();
