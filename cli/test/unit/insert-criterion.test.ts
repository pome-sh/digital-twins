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

  // F-1134 — the first write into an empty section landed the criterion directly
  // against the next heading. It parses either way, so this is cosmetic, but the
  // very first file `pome checks add` touches is the one an author reads most
  // carefully. Note the fixture: a section whose blank line is the ONLY thing
  // between the two headings. A hand-written task file looks like this; the
  // double-blank shape above already came out right.
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

  // F-1299: CRITERION_RE mirrors parseTask's CRITERION_LINE_RE by design (see
  // the comment above it) — it must recognise an always-scored marker as a
  // criterion line too, or a new criterion would insert BEFORE an existing
  // always-scored one instead of after it, exactly the same "line this regex
  // doesn't recognise gets skipped" defect class the parser fix is about.
  // The always-scored line has to be the LAST criterion for this to bite: with
  // any plain criterion below it, the insertion point is identical whether or
  // not CRITERION_RE recognises the keyword, and the test goes green against a
  // regex that never learned it.
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
