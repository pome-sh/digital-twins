// SPDX-License-Identifier: Apache-2.0
/**
 * F-1074 — append one rendered criterion to a task file's `## Success Criteria`,
 * touching nothing else.
 *
 * It does NOT parse and re-serialize the markdown. Re-serializing is how the
 * readable artifact drifts, and the north-star check on this ticket is that it
 * does not: authoring a criterion changes exactly one line.
 */
import { readCodeCriteria, readConfigTwins } from "./parseTask.js";

const HEADING_RE = /^##\s+Success Criteria\s*$/;
const NEXT_HEADING_RE = /^##\s+/;
// Mirrors CRITERION_LINE_RE in ./parseTask.ts — now byte-for-byte, capture
// groups included, so a divergence between the two is visible by eye. A
// criterion this regex does not recognise as one gets skipped when scanning for
// the last existing criterion (below), so an always-scored line that fell
// through here would let a new criterion insert BEFORE it instead of after.
//
// It reads a line; it does not VALIDATE one. A retired marker, or a tag naming
// no declared twin, is still the parser's error to raise. That is also why the
// `[code]` criteria this file compares against come from `readCodeCriteria`
// rather than from this regex (F-1443): the twin a bare marker attributes to is
// the parser's rule, and one rule in one place cannot disagree with itself.
const CRITERION_RE =
  /^[-*]\s+\[(code|model)(?::([a-z][a-z0-9_-]*))?(\s+always-scored)?\]\s+(.+)$/;

/** One criterion as the duplicate guard compares it — F-1443. NOT the rendered
 *  line: the same check has several legal spellings (`- [code] X`,
 *  `- [code:github] X` and `- [code always-scored] X` all name it on a github
 *  task), and comparing the text an author sees instead of the check it
 *  declares is what let a second graded copy of one check through. */
interface CriterionIdentity {
  kind: string;
  /** `tag ?? config.twins[0]`, RESOLVED — so a tagged marker and a bare one for
   *  the primary twin compare equal. */
  twin: string | undefined;
  text: string;
}

function identityKey(criterion: CriterionIdentity): string {
  // NUL separates the fields: it cannot occur in a marker or in a sentence, so a
  // text ending in a twin's name cannot collide with the next field.
  return `${criterion.kind}\u0000${criterion.twin ?? ""}\u0000${criterion.text}`;
}

/** Read one line as a criterion, or `undefined` when it is not one. Group 3 (the
 *  F-1299 `always-scored` keyword) is deliberately not read: it says how an
 *  existing check is scored, not what it checks (see
 *  `taskCriterionSchema.alwaysScored`), so `- [code] X` and
 *  `- [code always-scored] X` are ONE check — appending the second gives the
 *  task two graded copies of it. */
function readCriterionLine(
  line: string,
): { kind: string; tag: string | undefined; text: string } | undefined {
  const match = line.trim().match(CRITERION_RE);
  if (!match) return undefined;
  return { kind: match[1]!, tag: match[2], text: match[4]!.trim() };
}

/** The twin a bare marker attributes to — `config.twins[0]`, the rule both
 *  `parseCriteria` and `readCodeCriteria` apply. Tolerant for the same reason
 *  `readCodeCriteria` is tolerant: a malformed `## Config` is `parseTask`'s
 *  error to report, and turning an author's half-finished file into a crash is
 *  how an authoring surface stops being used. */
function primaryTwin(source: string): string | undefined {
  try {
    return readConfigTwins(source)[0];
  } catch {
    return undefined;
  }
}

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
  constructor(path: string, line: string, existing = line) {
    // F-1443 — echo the STORED spelling, and name the added one only when the
    // two differ. They now can: the guard matches `- [code] X` against a stored
    // `- [code always-scored] X`, and an author sent to look for a line their
    // file does not contain has nothing to search for.
    const differs = existing.trim() !== line.trim();
    super(
      `${path} already has this criterion:\n  ${existing.trim()}\n` +
        (differs
          ? `which is the same check as the one being added:\n  ${line.trim()}\n` +
            `— a marker annotation or a twin tag does not make it a second check.\n`
          : "") +
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

  // The task's twin context, which this function is not handed and does not need
  // to be: it already receives the source, and `## Config` is where the twins
  // are declared. Threading a twin down from `checks-add.ts` would put a SECOND
  // view of that fact next to the file's own, and a caller that disagreed with
  // the file is the same rendered-view-vs-parsed-truth split this fix closes.
  const primary = primaryTwin(source);

  // The `[code]` criteria the task already declares, keyed by identity and
  // valued by the spelling the file actually carries. `readCodeCriteria` is the
  // parser's own reader (F-1134): it applies the `tag ?? twins[0]` rule, so a
  // bare `- [code] X` recognises a stored `- [code:github] X` on a github task,
  // and its reconstructed `marker` is built to be searchable in the file — which
  // is what the refusal now quotes.
  //
  // Inherited tolerance: on a `## Config` that declares no twins the reader
  // returns nothing and the guard cannot fire. Such a task has no twin to grade
  // a `[code]` criterion against in the first place.
  const declared = new Map<string, string>();
  for (const criterion of readCodeCriteria(source)) {
    declared.set(
      identityKey({ kind: "code", twin: criterion.twin, text: criterion.text }),
      `- ${criterion.marker} ${criterion.text}`,
    );
  }

  let insertAt = -1;
  for (let i = start + 1; i < end; i += 1) {
    const parsed = readCriterionLine(lines[i]!);
    if (!parsed) continue;
    // `readCodeCriteria` is `[code]`-only by contract, so the `[model]` criteria
    // are read here — resolved by the same rule, so the two halves cannot
    // disagree about which twin a bare marker means.
    if (parsed.kind === "model") {
      declared.set(
        identityKey({ kind: "model", twin: parsed.tag ?? primary, text: parsed.text }),
        lines[i]!.trim(),
      );
    }
    insertAt = i + 1;
  }

  const incoming = readCriterionLine(line);
  if (incoming) {
    const stored = declared.get(
      identityKey({ kind: incoming.kind, twin: incoming.tag ?? primary, text: incoming.text }),
    );
    if (stored !== undefined) throw new DuplicateCriterionError(path, line, stored);
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
