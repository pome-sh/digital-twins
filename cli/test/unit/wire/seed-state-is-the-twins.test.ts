// SPDX-License-Identifier: Apache-2.0
//
// `cli/src/contract/seed-state.ts` declares the `/v1` seed surface, and its
// github arm was a HAND-WRITTEN copy of a shape the twin owns. Nothing compared
// the two. Measured 2026-08-29 against a maximal github seed, the copy silently
// dropped eight fields the twin models:
//
//     repositories[].private, .milestones, .tags, .releases
//     issues[].assignees        (replaced by a fabricated `assignee: null`)
//     issues[].comments
//     pull_requests[].comments, .review_comments
//
// It misled every reader and type-checker that trusted it — `GithubSeedState`
// is `z.infer` of this schema, so the TYPE said a seeded milestone did not
// exist. Nothing in this repo `.parse()`s it (the create-session boundary is a
// permissive `z.record` by design, F-580), which is exactly why the drift was
// invisible: a declaration that no test runs is a claim nothing checks.
//
// The fix is the one `cli/src/task/taskSchema.ts` already made — import the
// twin's own `seedSchema`. This file pins that by IDENTITY rather than by
// comparison: two objects that are the same object cannot drift, and a future
// hand-written re-fork fails here instead of in review.

import { describe, expect, it } from "vitest";
import { seedSchema as twinGithubSeedSchema } from "@pome-sh/twin-github/seed";
import {
  githubSeedStateSchema,
  providerScopedSeedStateSchema,
  seedStateSchema,
} from "../../../src/contract/seed-state.js";
import { seedStateSchema as taskSeedStateSchema } from "../../../src/task/taskSchema.js";

/** Every leaf-bearing field the deleted copy failed to model, with a value that
 *  is not the default, so a schema that dropped one shows it. */
const MAXIMAL_GITHUB_SEED = {
  users: [{ login: "vakoi", type: "Organization", name: "Vakoi Systems" }],
  repositories: [
    {
      owner: "vakoi",
      name: "billing",
      description: "Invoice and dunning service",
      private: true,
      default_branch: "trunk",
      collaborators: ["alice"],
      labels: [{ name: "bug", color: "d73a4a", description: "Something is not working" }],
      files: [{ path: "README.md", content: "# Billing\n", branch: "trunk" }],
      milestones: [{ number: 4, title: "v2.1", description: "d", state: "open", due_on: "2026-09-30T00:00:00Z" }],
      tags: [{ name: "v2.0.0", target: "trunk" }],
      releases: [{ tag_name: "v2.0.0", name: "Billing 2.0", body: "b", author: "alice" }],
      issues: [
        {
          number: 3,
          title: "Dunning retries fire twice on a 429",
          body: "Reproduced on staging.",
          state: "closed",
          labels: ["bug"],
          assignees: ["alice"],
          comments: [{ body: "Only under the read replica.", author: "bob" }],
        },
      ],
      pull_requests: [
        {
          number: 9,
          title: "Cap the dunning retry window",
          body: "Closes #3.",
          head: "retry-window",
          base: "trunk",
          state: "closed",
          author: "alice",
          reviews: [{ author: "bob", state: "CHANGES_REQUESTED", body: "One blocker." }],
          statuses: [{ context: "ci/dunning", state: "failure", description: "2 of 41 failing" }],
          comments: [{ body: "Rebased on trunk.", author: "alice" }],
          review_comments: [
            { body: "Drop the sleep.", path: "README.md", line: 1, side: "RIGHT", author: "bob" },
          ],
        },
      ],
    },
  ],
};

describe("the /v1 seed declaration is the twin's schema, not a copy of it", () => {
  it("`githubSeedStateSchema` IS `@pome-sh/twin-github`'s `seedSchema`", () => {
    expect(githubSeedStateSchema).toBe(twinGithubSeedSchema);
  });

  it("and so is the task parser's github arm — one object, three import sites", () => {
    expect(githubSeedStateSchema).toBe(twinGithubSeedSchema);
    // `taskSeedStateSchema` unions the five arms; the github one is the same
    // object, which is what makes "three copies" one.
    const options = (taskSeedStateSchema as unknown as { _zod: { def: { options: unknown[] } } })._zod
      .def.options;
    expect(options).toContain(twinGithubSeedSchema);
  });
});

describe("the eight fields the copy dropped now survive the declaration", () => {
  const parsed = githubSeedStateSchema.parse(MAXIMAL_GITHUB_SEED) as unknown as {
    repositories: Array<Record<string, unknown>>;
  };
  const repo = parsed.repositories[0]!;

  it.each(["private", "milestones", "tags", "releases"])("repositories[].%s", (field) => {
    expect(Object.keys(repo)).toContain(field);
  });

  it("issues[].assignees, not a fabricated singular `assignee`", () => {
    const issue = (repo.issues as Array<Record<string, unknown>>)[0]!;
    expect(issue.assignees).toEqual(["alice"]);
    expect(Object.keys(issue)).not.toContain("assignee");
  });

  it("issues[].comments", () => {
    const issue = (repo.issues as Array<Record<string, unknown>>)[0]!;
    expect(issue.comments).toEqual([{ body: "Only under the read replica.", author: "bob" }]);
  });

  it("pull_requests[].comments and .review_comments", () => {
    const pull = (repo.pull_requests as Array<Record<string, unknown>>)[0]!;
    expect(pull.comments).toEqual([{ body: "Rebased on trunk.", author: "alice" }]);
    expect((pull.review_comments as unknown[]).length).toBe(1);
  });
});

// The declaration is a union and a wrapper, and both still work — a github seed
// must not start matching some other twin's arm because the shape widened.
describe("the shapes around it still resolve to github", () => {
  it("the provider-scoped wrapper takes `{github: {seed}}`", () => {
    const parsed = providerScopedSeedStateSchema.parse({
      github: { seed: MAXIMAL_GITHUB_SEED },
    }) as { github?: { seed: { repositories: unknown[] } } };
    expect(parsed.github?.seed.repositories).toHaveLength(1);
  });

  it("the legacy-or-scoped union still takes a flat github seed", () => {
    const parsed = seedStateSchema.parse(MAXIMAL_GITHUB_SEED) as { repositories: unknown[] };
    expect(parsed.repositories).toHaveLength(1);
  });

  it("and still refuses a seed naming no twin at all", () => {
    expect(seedStateSchema.safeParse({ notion: { pages: [] } }).success).toBe(false);
  });
});
