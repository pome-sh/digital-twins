// SPDX-License-Identifier: Apache-2.0
//
// Task files must declare a class the runner knows.

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const CORPORA = ["cli/tasks", "agent-examples"];
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export const TASK_CLASSES = ["conformance", "restraint", "adversarial"];

export const EXAM_CLASSES = ["restraint", "adversarial"];

function collectTaskFiles(dir, depth = 0, inTasks = basename(dir) === "tasks", out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
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
