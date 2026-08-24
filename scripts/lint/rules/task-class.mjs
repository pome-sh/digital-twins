// SPDX-License-Identifier: Apache-2.0
//
// Every shipped task declares which POPULATION it belongs to.
//
// The corpus holds two kinds of file under one heading:
//
//   conformance  correct behaviour is "call the endpoints and do the obvious
//                thing". No planted hazard; no restraint carries the verdict.
//                These are the de-facto twin smoke test — they answer "does our
//                fake GitHub answer correctly", not "is the agent any good".
//   restraint    the verdict rests on NOT doing something, and there is no
//                antagonist. A leave-it-alone task, a don't-merge-a-red-PR task.
//   adversarial  a planted antagonist — injection, spoof, persuasion, backdoor,
//                exfiltration bait, fabrication pressure, a dedup trap.
//
// WHY THIS IS A GATE AND NOT A SPREADSHEET. `restraint` + `adversarial` are the
// EXAM population, and pome-cloud pins its scored denominators against them. One
// average over both populations cannot be read honestly: a rising number is
// either agents improving or us adding more plumbing questions, and nothing
// distinguishes them. A new task landing without a class would silently pick a
// side — whichever side the reader's default happened to be — so it is refused
// at the point of authoring instead.
//
// The walk mirrors pome-cloud's task-corpus walker: a task file is a `*.md`
// inside a corpus root, or anywhere in the SUBTREE of a directory named `tasks`
// at most MAX_DEPTH levels below it. Two walkers in two repos can drift on which
// files they even see; the defence against that is not this comment but the
// per-corpus task counts pinned cloud-side, which go red the moment the two
// disagree.
//
// What the subtree rule must NOT swallow is the `README.md` / `VERIFICATION.md`
// files sitting beside `agent-examples/<agent>/tasks` — a plain recursive `*.md`
// walk books them as tasks and inflates a pinned denominator with files carrying
// no criteria. They stay out because their directory is neither a corpus root nor
// under a `tasks/`.

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

// Both corpora, the same list pome-cloud's `DEFAULT_TASK_CORPORA` carries.
const CORPORA = ["cli/tasks", "agent-examples"];
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
      collectTaskFiles(join(dir, entry.name), depth + 1, inTasks || entry.name === "tasks", out);
    }
  }
  return out;
}

// The `## Config` fence, as a block of text. Deliberately NOT a YAML parse: this
// rule has to report on a file the YAML parser would throw on, and the twins
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
  return config.match(CLASS_LINE_RE)?.[1].replace(/^["'`]|["'`]$/g, "").trim() ?? null;
}

export default {
  name: "task-class",
  describe: `every shipped task declares class: ${TASK_CLASSES.join(" / ")}`,
  check(ctx) {
    const files = [];
    for (const corpus of CORPORA) {
      if (ctx.exists(corpus)) files.push(...collectTaskFiles(ctx.abs(corpus)));
    }
    files.sort();

    if (files.length === 0) {
      throw new Error(
        `No task files found under ${CORPORA.join(", ")}. Refusing to pass a zero-file scan: a corpus ` +
          `that stopped being found reads exactly like a corpus with nothing wrong in it.`,
      );
    }

    const violations = [];
    const counts = Object.fromEntries(TASK_CLASSES.map((cls) => [cls, 0]));

    for (const file of files) {
      const rel = ctx.rel(file);
      const declared = extractTaskClass(ctx.read(file));
      if (declared === null) {
        violations.push(
          `${rel}: no \`class:\` in its \`## Config\` block — an unclassified task silently joins ` +
            `whichever population the reader assumed, and pome-cloud scores the exam half separately.`,
        );
        continue;
      }
      if (!TASK_CLASSES.includes(declared)) {
        violations.push(`${rel}: \`class: ${declared}\` is not one of ${TASK_CLASSES.join(" / ")}`);
        continue;
      }
      counts[declared] += 1;
    }

    const exam = EXAM_CLASSES.reduce((total, cls) => total + counts[cls], 0);
    return {
      violations,
      summary:
        `${files.length} task(s): ` +
        TASK_CLASSES.map((cls) => `${counts[cls]} ${cls}`).join(", ") +
        `. Exam population (${EXAM_CLASSES.join(" + ")}): ${exam}.`,
    };
  },
};
