#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1302 — every shipped task declares which POPULATION it belongs to.
//
// The corpus holds two kinds of file under one heading, and until now nothing
// in either repo could tell them apart:
//
//   conformance  correct behaviour is "call the endpoints and do the obvious
//                thing". No planted hazard; no restraint carries the verdict.
//                These are the de-facto twin smoke test — a task was written
//                whenever a twin was added (19 of the 25 `cli/tasks` arrived in
//                the repo's FIRST commit, `6abec3c`, and 23's prompt is
//                literally "exercise all thirteen available Gmail tools"). They
//                answer "does our fake GitHub answer correctly", not "is the
//                agent any good".
//   restraint    the verdict rests on NOT doing something, and there is no
//                antagonist. A leave-it-alone task, a don't-merge-a-red-PR task.
//   adversarial  a planted antagonist — injection, spoof, persuasion, backdoor,
//                exfiltration bait, fabrication pressure, a dedup trap.
//
// WHY THIS IS A GATE AND NOT A SPREADSHEET. `restraint` + `adversarial` are the
// EXAM population, and pome-cloud pins its scored denominators against them
// (`CORPUS_SHAPE_BASELINE` in `apps/control-plane/scripts/resolve-criteria-corpus.ts`).
// One average over both populations cannot be read honestly: a rising number is
// either agents improving or us adding more plumbing questions, and nothing
// distinguishes them. A new task landing here WITHOUT a class would silently
// pick a side — whichever side the reader's default happened to be — so it is
// refused at the point of authoring instead.
//
// The walk mirrors `scripts/lib/task-corpus-dir.ts` in pome-cloud: a task file
// is a `*.md` inside a corpus root, or anywhere in the subtree of a directory
// named `tasks` at most MAX_DEPTH levels below it. Two walkers in two repos can
// drift on which files they even see; the defence against that is not this
// comment but the per-corpus task counts pinned cloud-side, which go red the
// moment the two disagree.
//
// THE SUBTREE, not just the direct children — F-1300's walker gap, picked up
// here because both walkers were being written anyway. The rule used to be
// "directly inside a directory named `tasks`", so `tasks/<topic>/x.md` was
// invisible: a task could leave the corpus by being filed one directory deeper,
// and the corpus watch would report clean. It moves no count today (no `tasks/`
// directory in this repo has a subdirectory), which is the reason it is safe to
// land alongside the classification rather than as its own measured change.
//
// What the subtree rule must NOT swallow is the ten `README.md` /
// `VERIFICATION.md` files sitting beside `examples/<agent>/tasks` — a plain
// recursive `*.md` walk books them as tasks and inflates a pinned denominator
// with files carrying no criteria. They stay out because their directory is
// neither a corpus root nor under a `tasks/`.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, join, relative } from "node:path";

const root = process.cwd();

// Both corpora, same list pome-cloud's `DEFAULT_TASK_CORPORA` carries.
const CORPORA = ["cli/tasks", "examples"];
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export const TASK_CLASSES = ["conformance", "restraint", "adversarial"];

// The EXAM half. Named here rather than derived as "not conformance" so that a
// fourth class arriving later has to state which side it falls on.
export const EXAM_CLASSES = ["restraint", "adversarial"];

function collectTaskFiles(dir, depth = 0, inTasks = basename(dir) === "tasks", out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // The root itself always counts, so an override pointed at a directory whose
  // name is not `tasks` still resolves.
  if (depth === 0 || inTasks) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(join(dir, entry.name));
    }
  }
  if (depth >= MAX_DEPTH) return out;
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      collectTaskFiles(
        join(dir, entry.name),
        depth + 1,
        inTasks || entry.name === "tasks",
        out,
      );
    }
  }
  return out;
}

// The `## Config` fence, as a block of text. Deliberately NOT a YAML parse: this
// gate has to report on a file the YAML parser would throw on, and the twins
// runtime parser (`cli/src/task/parseTask.ts`) is the one that owns rejecting
// malformed config.
const CONFIG_SECTION_RE = /^##\s+config\s*$/im;

export function extractConfigSection(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => CONFIG_SECTION_RE.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const CLASS_LINE_RE = /^\s*class\s*:\s*(\S+)\s*$/im;

/** The declared class, or null when the file declares none. */
export function extractTaskClass(markdown) {
  const config = extractConfigSection(markdown);
  if (config == null) return null;
  const match = config.match(CLASS_LINE_RE);
  if (!match) return null;
  return match[1].replace(/^["'`]|["'`]$/g, "").trim();
}

function main() {
  const files = [];
  for (const corpus of CORPORA) {
    const dir = join(root, corpus);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    files.push(...collectTaskFiles(dir));
  }
  files.sort();

  if (files.length === 0) {
    console.error(
      `No task files found under ${CORPORA.join(", ")}. Refusing to pass a zero-file scan: ` +
        `a corpus that stopped being found reads exactly like a corpus with nothing wrong ` +
        `in it (F-989).`,
    );
    process.exit(1);
  }

  const missing = [];
  const invalid = [];
  const counts = Object.fromEntries(TASK_CLASSES.map((c) => [c, 0]));

  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const declared = extractTaskClass(readFileSync(file, "utf8"));
    if (declared === null) {
      missing.push(rel);
      continue;
    }
    if (!TASK_CLASSES.includes(declared)) {
      invalid.push(`${rel}: \`class: ${declared}\``);
      continue;
    }
    counts[declared] += 1;
  }

  if (missing.length > 0 || invalid.length > 0) {
    if (missing.length > 0) {
      console.error(
        `Task(s) with no \`class:\` in their \`## Config\` block. Add one of ` +
          `${TASK_CLASSES.join(" / ")} — an unclassified task silently joins whichever ` +
          `population the reader assumed, and pome-cloud scores the exam half separately:`,
      );
      for (const file of missing) console.error(`  ${file}`);
    }
    if (invalid.length > 0) {
      console.error(`Task(s) declaring a class that is not one of ${TASK_CLASSES.join(" / ")}:`);
      for (const file of invalid) console.error(`  ${file}`);
    }
    process.exit(1);
  }

  const exam = EXAM_CLASSES.reduce((n, c) => n + counts[c], 0);
  console.log(
    `task-class gate passed — ${files.length} task(s): ` +
      TASK_CLASSES.map((c) => `${counts[c]} ${c}`).join(", ") +
      `. Exam population (${EXAM_CLASSES.join(" + ")}): ${exam}.`,
  );
}

// Importable by the regression suite beside it without running the walk.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
