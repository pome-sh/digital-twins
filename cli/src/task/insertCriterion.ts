// SPDX-License-Identifier: Apache-2.0
/**
 * F-1074 — append one rendered criterion to a task file's `## Success Criteria`,
 * touching nothing else.
 *
 * It does NOT parse and re-serialize the markdown. Re-serializing is how the
 * readable artifact drifts, and the north-star check on this ticket is that it
 * does not: authoring a criterion changes exactly one line.
 */

const HEADING_RE = /^##\s+Success Criteria\s*$/;
const NEXT_HEADING_RE = /^##\s+/;
// Mirrors CRITERION_LINE_RE in ./parseTask.ts, including the F-1299
// always-scored keyword — a criterion this regex does not recognise as one
// gets skipped when scanning for the last existing criterion (below), so an
// always-scored line that fell through here would let a new criterion insert
// BEFORE it instead of after. Used ONLY to find where the last existing
// criterion sits — never to validate one; that is the parser's job.
const CRITERION_RE =
  /^[-*]\s+\[(?:code|model)(?::[a-z][a-z0-9_-]*)?(?:\s+always-scored)?\]\s+.+$/;

export class MissingCriteriaSectionError extends Error {
  constructor(path: string) {
    super(
      `${path} has no \`## Success Criteria\` section. Add one and run this again — ` +
        `pome will not invent a section in a file it did not write.`,
    );
    this.name = "MissingCriteriaSectionError";
  }
}

// Found by driving the command: authoring a criterion a task already carries
// adds it twice, and the grader scores both — the denominator inflates and the
// task's percentage moves for a reason nobody wrote down. That is the exact
// class of silent denominator change this milestone exists to remove, so it is
// a refusal rather than a warning.
export class DuplicateCriterionError extends Error {
  constructor(path: string, line: string) {
    super(
      `${path} already has this criterion:\n  ${line}\n` +
        `Adding it again would score it twice and inflate the task's denominator.`,
    );
    this.name = "DuplicateCriterionError";
  }
}

export function insertCriterion(source: string, line: string, path = "this task file"): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => HEADING_RE.test(l));
  if (start === -1) throw new MissingCriteriaSectionError(path);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (NEXT_HEADING_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  let insertAt = -1;
  for (let i = start + 1; i < end; i += 1) {
    const existing = lines[i]!.trim();
    if (!CRITERION_RE.test(existing)) continue;
    if (existing === line.trim()) throw new DuplicateCriterionError(path, line);
    insertAt = i + 1;
  }
  if (insertAt === -1) {
    // Empty section: land after the heading's blank line, so the result reads
    // like every shipped task instead of butting against the heading.
    insertAt = lines[start + 1]?.trim() === "" ? start + 2 : start + 1;
  }

  // F-1134 — a section whose only content is its blank line puts `insertAt` on
  // the NEXT heading, so the criterion would land against it with nothing
  // between. Cosmetic (it parses either way), but this is the very first write
  // into a freshly scaffolded task, which is the file an author reads hardest.
  const blankAfter = NEXT_HEADING_RE.test(lines[insertAt] ?? "") ? [""] : [];
  lines.splice(insertAt, 0, line, ...blankAfter);
  return lines.join("\n");
}
