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

  it("handles the section being last in the file", () => {
    const last = "# T\n\n## Success Criteria\n\n- [code] A\n";
    expect(insertCriterion(last, "- [code] B")).toBe(
      "# T\n\n## Success Criteria\n\n- [code] A\n- [code] B\n",
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
