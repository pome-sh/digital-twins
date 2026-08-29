// SPDX-License-Identifier: Apache-2.0
//
// A seed field a human writes comes back unchanged, or the parse says so.
//
// This is the milestone property stated as a test, and it is the guard F-581
// asks for. Two halves, and NEITHER is sufficient alone:
//
//   PRESERVATION  every scalar leaf in a maximal fixture is present and
//                 JSON-equal after `.parse()`. Not `toEqual`: zod ADDS defaulted
//                 keys and LEAVES absent optionals absent, so a deep comparison
//                 false-fails against a schema that is behaving.
//
//   COVERAGE      every leaf-bearing field the schema declares is reached by the
//                 fixture. Without it the first half is vacuous in exactly the
//                 direction that matters — a fixture missing a field cannot
//                 notice the field being dropped, and a NEW seed field could
//                 land uncovered forever. This is the half that reds when
//                 someone widens a twin's seed schema and writes no fixture.
//
// ⚠️ WHY THIS EXISTS AT ALL. `cli/src/contract/seed-state.ts` hand-wrote the
// github seed shape and nothing compared it to the twin's. Measured 2026-08-29
// against the fixture below, it silently dropped EIGHT fields the twin models:
//
//     repositories[].private, .milestones, .tags, .releases
//     issues[].assignees        (replaced by a fabricated `assignee: null`)
//     issues[].comments
//     pull_requests[].comments, .review_comments
//
// That copy is gone — it imports the twin's `seedSchema` now, the way
// `cli/src/task/taskSchema.ts` already did — so the drift cannot recur by
// construction. What CAN still recur is a schema that loses a field on its own,
// or a fixture that stops being maximal, and that is what this file holds.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { $ZodType } from "zod/v4/core";

import * as github from "../src/github.js";
import * as slack from "../src/slack.js";
import * as stripe from "../src/stripe.js";
import { at, coveredBy, covers, generic, leafFieldsOf, leavesOf } from "./_seedLeaves.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/seed-maximal.${name}.json`, import.meta.url), "utf8"));

/** One row per twin. The helper takes `(schema, fixture)` so a twin is a row
 *  here and a JSON file beside it — nothing else. gmail and linear have no
 *  fixture yet; neither F-581 nor F-584 covers them. */
const TWINS = [
  {
    twin: "github",
    schema: github.seedSchema as unknown as $ZodType,
    parseSeed: github.parseSeed as (input: unknown) => unknown,
    fixture: fixture("github"),
  },
  {
    twin: "stripe",
    schema: stripe.seedSchema as unknown as $ZodType,
    parseSeed: stripe.parseSeed as (input: unknown) => unknown,
    fixture: fixture("stripe"),
  },
  {
    twin: "slack",
    schema: slack.seedSchema as unknown as $ZodType,
    parseSeed: slack.parseSeed as (input: unknown) => unknown,
    fixture: fixture("slack"),
  },
] as const;

describe("a maximal seed survives its twin's own schema, leaf by leaf", () => {
  it.each(TWINS)("$twin", ({ parseSeed, fixture: input }) => {
    const parsed = parseSeed(input);
    const leaves = leavesOf(input);
    // A walk that found nothing would pass every assertion below.
    expect(leaves.length).toBeGreaterThan(30);

    const altered: Array<{ path: string; wrote: unknown; got: unknown }> = [];
    for (const leaf of leaves) {
      const got = at(parsed, leaf.path);
      if (JSON.stringify(got) !== JSON.stringify(leaf.value)) {
        altered.push({ path: leaf.path, wrote: leaf.value, got });
      }
    }
    expect(altered).toEqual([]);
  });
});

describe("the fixture reaches every field the schema declares", () => {
  it.each(TWINS)("$twin", ({ schema, fixture: input }) => {
    const declared = leafFieldsOf(schema);
    expect(declared.length).toBeGreaterThan(20);

    const covered = coveredBy(input);
    const uncovered = declared.filter((field) => !covers(covered, field));
    expect(uncovered).toEqual([]);
  });

  // The inverse direction. A fixture path the schema does not declare would be
  // refused outright now that the seed schemas are strict (F-1689), so this is
  // belt and braces — but it also catches a path the walk MISREADS, which
  // strictness cannot.
  it.each(TWINS)("$twin: and reaches nothing the schema does not", ({ schema, fixture: input }) => {
    const declared = new Set(leafFieldsOf(schema));
    const stray = [...coveredBy(input)].filter((path) => {
      for (const field of declared) if (path === field || path.startsWith(`${field}.`)) return false;
      return true;
    });
    expect(stray).toEqual([]);
  });
});

// The contract copy is gone; this is what says so, by identity rather than by
// comparison. `cli/src/contract/seed-state.ts` and `cli/src/task/taskSchema.ts`
// both name the SAME object the twin exports, so there is no second shape left
// to drift — and a future hand-written re-fork reds here, not in review.
describe("nothing re-forks the github seed shape", () => {
  it("`@pome-sh/checks` re-exports the twin's own object, not a copy of it", async () => {
    const twin = await import("@pome-sh/twin-github/seed");
    expect(github.seedSchema).toBe(twin.seedSchema);
    expect(github.parseSeed).toBe(twin.parseSeed);
  });

  it("a maximal seed and its parse agree on the field set at every level", () => {
    const parsed = github.parseSeed(fixture("github")) as {
      repositories: Array<Record<string, unknown>>;
    };
    const repo = parsed.repositories[0]!;
    // The eight fields the deleted copy dropped, asserted by name so the
    // regression this closes is readable without running git.
    for (const field of ["private", "milestones", "tags", "releases"]) {
      expect(Object.keys(repo)).toContain(field);
    }
    const issue = (repo.issues as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(issue)).toContain("assignees");
    expect(Object.keys(issue)).toContain("comments");
    expect(Object.keys(issue)).not.toContain("assignee");
    const pull = (repo.pull_requests as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(pull)).toContain("comments");
    expect(Object.keys(pull)).toContain("review_comments");
  });
});

// A path helper that silently returned `undefined` for everything would make
// the preservation assert pass on any schema at all.
describe("the walk itself", () => {
  it("reports an altered leaf rather than skipping it", () => {
    const wrote = { a: [{ b: "kept", c: "lost" }] };
    const got = { a: [{ b: "kept" }] };
    const altered = leavesOf(wrote).filter(
      (leaf) => JSON.stringify(at(got, leaf.path)) !== JSON.stringify(leaf.value),
    );
    expect(altered.map((leaf) => leaf.path)).toEqual(["a.[0].c"]);
  });

  it("collapses array indices so a fixture path and a schema path compare", () => {
    expect(generic("repositories.[0].issues.[2].labels.[0]")).toBe(
      "repositories.[].issues.[].labels.[]",
    );
  });
});
