// SPDX-License-Identifier: Apache-2.0
//
// `censusState` — the diff plus the collections nothing touched, plus a count
// at each end (F-1850 · D3).
//
// The thing these cases are really guarding is that the counts and the diff
// come out of ONE traversal. A count taken separately can pick a different
// identity key for the same collection, emit `repositories[1].issues`, and
// produce a number that joins to no diff entry — so several cases below assert
// the paths agree, not just the numbers.
import { describe, expect, it } from "vitest";
import { censusState, diffState } from "../../../src/twin/stateDiff.js";

const SEED = {
  repositories: [
    {
      full_name: "acme/api",
      labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
      issues: [{ number: 1, title: "500 on POST /orders", labels: [{ name: "bug" }] }],
      pull_requests: [],
    },
  ],
};

describe("censusState", () => {
  it("counts every collection, including the ones nothing touched", () => {
    const census = censusState(SEED, SEED);
    const byPath = Object.fromEntries(census.map((entry) => [entry.path, [entry.boot, entry.now]]));
    // Every one of these is an array of rows; the membership case has its own
    // test below.
    expect(census.every((entry) => entry.kind === "collection")).toBe(true);

    expect(byPath).toEqual({
      repositories: [1, 1],
      "repositories[acme/api].labels": [3, 3],
      "repositories[acme/api].issues": [1, 1],
      "repositories[acme/api].issues[#1].labels": [1, 1],
      "repositories[acme/api].pull_requests": [0, 0],
    });
  });

  it("keeps a repo's own labels and an issue's labels as two paths, not one", () => {
    // The reason the panel is path-keyed at all: GitHub exports `labels` at
    // both levels, so counting by NAME would report four labels on a repo that
    // has three.
    const census = censusState(SEED, SEED);
    const labels = census.filter((entry) => entry.path.endsWith(".labels"));
    // Tree order: a repo's fields are visited sorted, so `issues` and
    // everything nested under it come out before the repo's own `labels`.
    expect(labels.map((entry) => `${entry.path}=${entry.now}`)).toEqual([
      "repositories[acme/api].issues[#1].labels=1",
      "repositories[acme/api].labels=3",
    ]);
  });

  it("reports an addition on the same path the diff reports it on", () => {
    const after = structuredClone(SEED);
    after.repositories[0]!.issues.push({ number: 2, title: "Login 500", labels: [] });

    const census = censusState(SEED, after);
    const issues = census.find((entry) => entry.path === "repositories[acme/api].issues");
    expect(issues).toMatchObject({ boot: 1, now: 2, added: ["#2"], changed: [], removed: [] });

    // The join the world panel depends on: every diff path exists in the census.
    const paths = new Set(census.map((entry) => entry.path));
    for (const entry of diffState(SEED, after)) expect(paths).toContain(entry.path);
  });

  it("lets a count fall to zero rather than dropping the collection", () => {
    const after = structuredClone(SEED);
    after.repositories[0]!.issues = [];

    const issues = censusState(SEED, after).find(
      (entry) => entry.path === "repositories[acme/api].issues",
    );
    // A row that vanished at zero would read as a bug in the page rather than
    // as a deletion in the twin.
    expect(issues).toMatchObject({ boot: 1, now: 0, removed: ["#1"] });
  });

  it("counts a membership array by its length, not its distinct values", () => {
    const before = { channel: { members: ["u1", "u2"] } };
    const after = { channel: { members: ["u1", "u2", "u2", "u3"] } };
    expect(censusState(before, after)).toEqual([
      {
        path: "channel.members",
        boot: 2,
        now: 4,
        // A join table, not a collection of rows — the world panel gives these
        // no slot of their own (F-1850 · D3).
        kind: "membership",
        added: ["u2", "u3"],
        changed: [],
        removed: [],
      },
    ]);
  });

  it("with changedOnly, says exactly what diffState says", () => {
    const after = structuredClone(SEED);
    after.repositories[0]!.labels.push({ name: "p0" });

    const trimmed = censusState(SEED, after, { changedOnly: true }).map(
      ({ path, added, changed, removed }) => ({ path, added, changed, removed }),
    );
    expect(trimmed).toEqual(diffState(SEED, after));
  });
});

describe("diffState is unchanged by the census sharing its traversal", () => {
  it("still omits collections nothing touched, and carries no counts", () => {
    const after = structuredClone(SEED);
    after.repositories[0]!.labels.push({ name: "p0" });

    const diff = diffState(SEED, after);
    expect(diff).toEqual([
      {
        path: "repositories[acme/api].labels",
        added: ["p0"],
        changed: [],
        removed: [],
      },
    ]);
    // `pome twin tape --json` publishes this shape; a stray `boot`/`now` here
    // would change a documented output.
    expect(Object.keys(diff[0]!).sort()).toEqual(["added", "changed", "path", "removed"]);
  });
});
