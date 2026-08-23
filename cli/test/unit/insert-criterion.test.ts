// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DuplicateCriterionError,
  MissingCriteriaSectionError,
  insertCriterion,
} from "../../src/task/insertCriterion.js";

const TASK = `# Task 03 — Already triaged

## Prompt

Triage issue #1 in acme/api.

## Success Criteria

- [code] Issue #1 is still assigned to \`alice\`
- [model] The agent explains itself

## Config

\`\`\`yaml
twins: [github]
\`\`\`
`;

describe("insertCriterion", () => {
  it("appends after the last criterion and changes exactly one line", () => {
    const line = "- [code] No new labels were created in `acme/api`";
    const out = insertCriterion(TASK, line);
    expect(out.split("\n").length).toBe(TASK.split("\n").length + 1);
    // Removing the one added line restores the file byte-for-byte. This is the
    // north-star check: the authored artifact changes, the readable one does not.
    expect(out.replace(`${line}\n`, "")).toBe(TASK);
  });

  it("lands INSIDE the section, before the next heading", () => {
    const out = insertCriterion(TASK, "- [code] X");
    expect(out.indexOf("- [code] X")).toBeGreaterThan(out.indexOf("## Success Criteria"));
    expect(out.indexOf("- [code] X")).toBeLessThan(out.indexOf("## Config"));
  });

  it("appends after the LAST criterion, not the first", () => {
    const out = insertCriterion(TASK, "- [code] X").split("\n");
    expect(out[out.indexOf("- [code] X") - 1]).toBe("- [model] The agent explains itself");
  });

  it("handles a section that has no criteria yet", () => {
    const empty = TASK.replace(
      "- [code] Issue #1 is still assigned to `alice`\n- [model] The agent explains itself\n",
      "",
    );
    const out = insertCriterion(empty, "- [code] X");
    expect(out).toContain("## Success Criteria\n\n- [code] X");
  });

  // The first write into an empty section landed the criterion directly against the
  // next heading.
  it("keeps a blank line between the criterion and the next heading", () => {
    const bare = "# T\n\n## Success Criteria\n\n## Config\n\n```yaml\ntwins: [github]\n```\n";
    expect(insertCriterion(bare, "- [code] X")).toBe(
      "# T\n\n## Success Criteria\n\n- [code] X\n\n## Config\n\n```yaml\ntwins: [github]\n```\n",
    );
  });

  it("does not add a second blank line when one already follows", () => {
    const out = insertCriterion(TASK, "- [code] X");
    expect(out).toContain("- [code] X\n\n## Config");
    expect(out).not.toContain("- [code] X\n\n\n## Config");
  });

  it("handles the section being last in the file", () => {
    const last = "# T\n\n## Success Criteria\n\n- [code] A\n";
    expect(insertCriterion(last, "- [code] B")).toBe(
      "# T\n\n## Success Criteria\n\n- [code] A\n- [code] B\n",
    );
  });

  // CRITERION_RE mirrors parseTask's CRITERION_LINE_RE by design (see the comment
  // above it) — it must recognise an always-scored marker as a criterion line.
  it("appends after an existing always-scored criterion, not before it", () => {
    const withAlwaysScored = TASK.replace(
      "- [model] The agent explains itself",
      "- [model] The agent explains itself\n- [code always-scored] No new labels were created",
    );
    const out = insertCriterion(withAlwaysScored, "- [code] X").split("\n");
    expect(out[out.indexOf("- [code] X") - 1]).toBe(
      "- [code always-scored] No new labels were created",
    );
  });

  it("refuses a file with no Success Criteria section, and names it", () => {
    expect(() => insertCriterion("# T\n\n## Prompt\n\ngo\n", "- [code] X", "tasks/t.md")).toThrow(
      MissingCriteriaSectionError,
    );
    expect(() => insertCriterion("# T\n", "- [code] X", "tasks/t.md")).toThrow(/tasks\/t\.md/);
  });

  it("refuses to add a criterion the task already carries", () => {
    // Found by driving the command against a real task file: a duplicate line is
    // scored twice, so the denominator inflates and the percentage moves for a
    // reason nobody wrote down.
    const line = "- [model] The agent explains itself";
    expect(() => insertCriterion(TASK, line, "tasks/03.md")).toThrow(DuplicateCriterionError);
    expect(() => insertCriterion(TASK, line, "tasks/03.md")).toThrow(/score it twice/);
  });
});

// The shape of `cli/tasks/03-already-triaged.md`: a single-twin github task whose
// criteria carry the `always-scored` keyword.
const TRIAGED = `# Task 03 — Already triaged

## Prompt

Triage issue #1 in acme/api.

## Success Criteria

- [code always-scored] Issue #1 in \`acme/api\` is assigned to \`alice\`
- [code always-scored] No new labels were created in \`acme/api\`
- [code] No unsupported endpoint was called

## Config

\`\`\`yaml
twins: [github]
\`\`\`
`;

/** Byte-for-byte what `checks-add.ts` renders for that check on a single-twin
 *  task: `- [code${tagged ? ":" + twin : ""}] ${renderCheck(picked, args)}`. */
const RENDERED = "- [code] No new labels were created in `acme/api`";

describe("insertCriterion duplicate guard reads criteria, not rendered lines", () => {
  it("refuses `- [code] X` against a stored `- [code always-scored] X`", () => {
    // The keyword annotates HOW an existing check is scored, not WHAT it checks
    // (see `taskCriterionSchema.alwaysScored`), so the two lines are one check.
    // Appending the second gives the task two graded copies of it.
    expect(() => insertCriterion(TRIAGED, RENDERED, "tasks/03-already-triaged.md")).toThrow(
      DuplicateCriterionError,
    );
    expect(() => insertCriterion(TRIAGED, RENDERED, "tasks/03-already-triaged.md")).toThrow(
      /score it twice/,
    );
  });

  it("refuses `- [code] X` against a stored `- [code:github] X`", () => {
    // Same miss with a twin tag. A bare marker attributes to the task's primary
    // twin, which on this task IS `github` — so an author who tagged the line by
    // hand and a `checks add` that renders it bare mean the same check.
    const tagged = TRIAGED.replace(
      "- [code always-scored] No new labels were created in `acme/api`",
      "- [code:github] No new labels were created in `acme/api`",
    );
    expect(() => insertCriterion(tagged, RENDERED, "tasks/03.md")).toThrow(DuplicateCriterionError);
    expect(() => insertCriterion(tagged, RENDERED, "tasks/03.md")).toThrow(/score it twice/);
  });

  it("still accepts a criterion that merely shares a prefix with a stored one", () => {
    // The over-correction guard, and the one that matters most in daily use: a
    // guard that matched on a prefix, or on the marker alone, would refuse both
    // of these. Blocking a legitimate `checks add` is the quieter failure of the
    // two — the author has no error to search for, just a command that says no.
    const longer = "- [code] No new labels were created in `acme/api` or `acme/web`";
    expect(insertCriterion(TRIAGED, longer).split("\n")).toContain(longer);
    const shorter = "- [code] No new labels were created";
    expect(insertCriterion(TRIAGED, shorter).split("\n")).toContain(shorter);
  });

  it("still accepts a criterion that differs only in kind, or only in twin", () => {
    // The comparison is the whole triple, so the other two legs have to
    // discriminate as well. A [model] restatement is judged from the run rather
    // than read off the seed — a different check, not a duplicate…
    const asModel = "- [model] No new labels were created in `acme/api`";
    expect(insertCriterion(TRIAGED, asModel).split("\n")).toContain(asModel);
    // …and in a multi-twin task the same sentence tagged to another twin reads
    // another twin's state.
    const multi = TRIAGED.replace("twins: [github]", "twins: [github, slack]").replace(
      "- [code always-scored] No new labels were created in `acme/api`",
      "- [code:github] No new labels were created in `acme/api`",
    );
    const otherTwin = "- [code:slack] No new labels were created in `acme/api`";
    expect(insertCriterion(multi, otherTwin).split("\n")).toContain(otherTwin);
  });
});
