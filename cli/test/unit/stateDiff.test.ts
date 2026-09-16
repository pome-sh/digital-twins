// SPDX-License-Identifier: Apache-2.0
// `pome twin tape --diff` reports a run's leftovers per collection (F-1837).
// These pin the diff on a github-shaped export: rows matched by identity, a
// nested add reported under its parent's path, a scalar change reported as
// "changed", and index labels for rows with no identity field.

import { describe, expect, it } from "vitest";
import { diffState, identityKeyOf, renderStateDiff } from "../../src/twin/stateDiff.js";

const repo = (issues: unknown[], labels: unknown[] = []) => ({
  id: 7,
  full_name: "acme/api",
  default_branch: "main",
  issues,
  labels,
});
const issue = (number: number, title: string, labels: string[] = []) => ({
  id: 1000 + number,
  number,
  title,
  state: "open",
  labels: labels.map((name) => ({ name })),
});

describe("diffState", () => {
  it("reports nothing for identical exports", () => {
    const state = { repositories: [repo([issue(1, "Old bug")])] };
    expect(diffState(state, structuredClone(state))).toEqual([]);
  });

  it("reports an added row under its parent's identity path, not as a changed parent", () => {
    const before = { repositories: [repo([issue(1, "Old bug")])] };
    const after = { repositories: [repo([issue(1, "Old bug"), issue(2, "Login 500 after deploy")])] };
    expect(diffState(before, after)).toEqual([
      { path: "repositories[acme/api].issues", added: ["#2"], changed: [], removed: [] },
    ]);
  });

  it("reports a scalar change as changed, and a nested add beside it", () => {
    const before = { repositories: [repo([issue(1, "Old bug")])] };
    const after = {
      repositories: [repo([issue(1, "Old bug", ["p0"])], [{ name: "p0", color: "ff0000" }])],
    };
    const diff = diffState(before, after);
    expect(diff).toEqual([
      { path: "repositories[acme/api].issues[#1].labels", added: ["p0"], changed: [], removed: [] },
      { path: "repositories[acme/api].labels", added: ["p0"], changed: [], removed: [] },
    ]);
    const retitled = { repositories: [repo([issue(1, "Old bug, retitled")])] };
    expect(diffState(before, retitled)).toEqual([
      { path: "repositories[acme/api].issues", added: [], changed: ["#1"], removed: [] },
    ]);
  });

  it("reports removed rows and a whole new top-level row", () => {
    const before = { repositories: [repo([issue(1, "Old bug")])] };
    const after = {
      repositories: [
        repo([]),
        { id: 8, full_name: "vakoi/billing", default_branch: "main", issues: [], labels: [] },
      ],
    };
    expect(diffState(before, after)).toEqual([
      { path: "repositories", added: ["vakoi/billing"], changed: [], removed: [] },
      { path: "repositories[acme/api].issues", added: [], changed: [], removed: ["#1"] },
    ]);
  });

  it("matches rows by the first identity field they all carry, else by index", () => {
    expect(identityKeyOf([{ id: 1 }, { id: 2 }])).toBe("id");
    expect(identityKeyOf([{ number: 1, id: 9 }, { number: 2, id: 9 }])).toBe("number");
    expect(identityKeyOf([{ ts: "1.0" }, { ts: "2.0" }])).toBe("ts");
    expect(identityKeyOf([{ body: "a" }, { body: "b" }])).toBeUndefined();
    // The same row on both sides is the match, not a duplicate.
    expect(identityKeyOf([{ id: 7, full_name: "acme/api" }], [{ id: 7, full_name: "acme/api" }])).toBe("full_name");
    // A human name beats a numeric id when both are unique.
    expect(identityKeyOf([{ id: 3, name: "p0" }, { id: 4, name: "bug" }])).toBe("name");
    const before = { messages: [{ body: "a" }] };
    const after = { messages: [{ body: "a" }, { body: "b" }] };
    expect(diffState(before, after)).toEqual([
      { path: "messages", added: ["#1"], changed: [], removed: [] },
    ]);
  });

  it("renders one line per changed collection, aligned", () => {
    const lines = renderStateDiff([
      { path: "repositories[acme/api].issues", added: ["#2"], changed: [], removed: [] },
      { path: "repositories[acme/api].labels", added: ["p0"], changed: ["bug"], removed: ["wontfix"] },
    ]);
    expect(lines[0]).toBe("State diff since boot (seed → now):");
    expect(lines[1]).toBe("  repositories[acme/api].issues  +1 added: #2");
    expect(lines[2]).toBe("  repositories[acme/api].labels  +1 added: p0; ~1 changed: bug; -1 removed: wontfix");
    expect(renderStateDiff([])).toEqual(["State: unchanged since boot."]);
  });
});
