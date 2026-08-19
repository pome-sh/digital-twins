// SPDX-License-Identifier: Apache-2.0
//
// F-1421 — the five entities twin-github SERVES but its seed could not express:
// milestones, tags, releases, issue comments and pull-request review comments.
// `seedSchema` had no field for any of them and zod strips unknown keys, so a
// seed naming one reached the domain as nothing at all and `GET /milestones`,
// `/tags`, `/releases`, `/issues/:n/comments` and `/pulls/:n/comments` could
// only ever answer `[]`.
//
// That is invisible to a shape-diff rather than merely wrong: the diff engine
// returns before the per-element shape union when EITHER side is empty, so
// `[] vs []` compares zero elements and publishes green, and `[1] vs []`
// compares zero elements and publishes an array-length red. Only a seeded
// element gets a real comparison.
//
// The two surfaces that were already reachable — a PR's reviews and an issue
// the seed closes — are asserted here beside the five, because the unit this
// ticket is measured in is the seven-surface set.
//
// EVERY assertion below runs against two worlds that differ only in the value
// the seed plants. Asserting "the array came back non-empty" would repeat the
// original mistake one level up: it passes against a twin answering a constant.
// Asserting the planted value AND that the other world answers differently is
// what makes the element load-bearing — a wrong value in it produces drift.
//
// The world is shaped like pome-cloud's `FIDELITY_SEED` (acme/api, issues #1
// and #2, PR #3 off `feature`) so this doubles as a rehearsal of the seed the
// fidelity watch will run. Note the trap it encodes: issues and pull requests
// draw numbers from ONE per-repo counter, so the closed issue is issue #2
// flipped rather than a third issue — a third would move the PR to #4 and break
// every `/pulls/3/...` handle downstream.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
import { createGitHubCloneApp } from "../src/twin.js";
import { defaultSeedState, parseSeed } from "../src/seed.js";
import type { GitHubStateSeed } from "../src/types.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

/** The values the seed plants — one per surface, different in each world. */
type Planted = {
  milestoneTitle: string;
  tagName: string;
  releaseBody: string;
  issueCommentBody: string;
  reviewCommentBody: string;
  reviewBody: string;
  closedIssueTitle: string;
};

const WORLD_A: Planted = {
  milestoneTitle: "v1.0 — checkout hardening",
  tagName: "v1.0.0",
  releaseBody: "First cut of the ordering API.",
  issueCommentBody: "Reproduced on staging at 14:07.",
  reviewCommentBody: "This flag needs a default.",
  reviewBody: "Looks right to me.",
  closedIssueTitle: "Seeded closed: retry storm on 429"
};

const WORLD_B: Planted = {
  milestoneTitle: "v2.0 — regional failover",
  tagName: "v2.3.1",
  releaseBody: "Adds the failover path.",
  issueCommentBody: "Only reproduces under the read replica.",
  reviewCommentBody: "Drop the sleep, it hides the race.",
  reviewBody: "One blocker before this lands.",
  closedIssueTitle: "Seeded closed: duplicate webhook delivery"
};

function world(planted: Planted): GitHubStateSeed {
  return {
    users: [
      { login: "acme", type: "Organization", name: "Acme" },
      { login: "alice", type: "User", name: "Alice" },
      { login: "bob", type: "User", name: "Bob" },
      { login: "pome-agent", type: "User", name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        description: "Fidelity sandbox repository for twin-github capture.",
        default_branch: "main",
        collaborators: ["alice", "bob", "pome-agent"],
        labels: [
          { name: "bug", color: "d73a4a", description: "Something is not working" },
          { name: "feature", color: "a2eeef", description: "New feature or request" }
        ],
        files: [
          { path: "README.md", content: "# Acme API\n\nFidelity sandbox.\n" },
          { path: "src/index.ts", content: "export const ok = true;\n" },
          { path: "src/feature.ts", content: "export const feature = true;\n", branch: "feature" }
        ],
        milestones: [
          {
            number: 1,
            title: planted.milestoneTitle,
            description: "Everything blocking the next tag.",
            state: "open",
            due_on: "2026-09-30T00:00:00Z"
          }
        ],
        tags: [{ name: planted.tagName, target: "main" }],
        releases: [
          {
            tag_name: planted.tagName,
            name: `Release ${planted.tagName}`,
            body: planted.releaseBody,
            author: "alice"
          }
        ],
        issues: [
          {
            number: 1,
            title: "Seeded bug: 500 on POST /orders",
            body: "Started failing after the 14:00 deploy.",
            state: "open",
            labels: ["bug"],
            assignees: ["alice"],
            comments: [{ body: planted.issueCommentBody, author: "bob" }]
          },
          {
            number: 2,
            title: planted.closedIssueTitle,
            body: "Fixed by the backoff change.",
            state: "closed",
            labels: ["bug"],
            assignees: []
          }
        ],
        pull_requests: [
          {
            title: "Add feature flag",
            body: "Introduces a feature branch.",
            head: "feature",
            base: "main",
            author: "pome-agent",
            reviews: [{ author: "alice", state: "APPROVED", body: planted.reviewBody }],
            review_comments: [
              { body: planted.reviewCommentBody, path: "src/feature.ts", line: 1, author: "bob" }
            ]
          }
        ]
      }
    ]
  };
}

async function get(app: ReturnType<typeof createGitHubCloneApp>, path: string) {
  const response = await app.request(`${base}${path}`, withAuth(token));
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
}

function appFor(planted: Planted) {
  return createGitHubCloneApp({ seed: world(planted) });
}

/**
 * The seven surfaces the ticket is measured in, each with the field the seed
 * plants and where the served element carries it.
 */
const SURFACES: Array<{
  id: string;
  path: string;
  planted: (world: Planted) => string;
  served: (body: any) => unknown;
}> = [
  {
    id: "GET /repos/:o/:r/milestones",
    path: "/repos/acme/api/milestones",
    planted: (w) => w.milestoneTitle,
    served: (body) => body[0]?.title
  },
  {
    id: "GET /repos/:o/:r/tags",
    path: "/repos/acme/api/tags",
    planted: (w) => w.tagName,
    served: (body) => body[0]?.name
  },
  {
    id: "GET /repos/:o/:r/releases",
    path: "/repos/acme/api/releases",
    planted: (w) => w.releaseBody,
    served: (body) => body[0]?.body
  },
  {
    id: "GET /repos/:o/:r/issues/:n/comments",
    path: "/repos/acme/api/issues/1/comments",
    planted: (w) => w.issueCommentBody,
    served: (body) => body[0]?.body
  },
  {
    id: "GET /repos/:o/:r/pulls/:n/comments",
    path: "/repos/acme/api/pulls/3/comments",
    planted: (w) => w.reviewCommentBody,
    served: (body) => body[0]?.body
  },
  {
    id: "GET /repos/:o/:r/pulls/:n/reviews",
    path: "/repos/acme/api/pulls/3/reviews",
    planted: (w) => w.reviewBody,
    served: (body) => body[0]?.body
  },
  {
    id: "GET /repos/:o/:r/issues?state=closed",
    path: "/repos/acme/api/issues?state=closed",
    planted: (w) => w.closedIssueTitle,
    served: (body) => body[0]?.title
  }
];

describe("F-1421 — seeded surfaces serve an element a diff can compare", () => {
  it.each(SURFACES)(
    "$id serves the value THIS seed planted, and a different seed a different one",
    async ({ path, planted, served }) => {
      const a = await get(appFor(WORLD_A), path);
      const b = await get(appFor(WORLD_B), path);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(Array.isArray(a.body)).toBe(true);
      // ≥1 element is the precondition for the comparison, not the assertion.
      expect(a.body.length).toBeGreaterThanOrEqual(1);
      expect(b.body.length).toBeGreaterThanOrEqual(1);

      expect(served(a.body)).toBe(planted(WORLD_A));
      expect(served(b.body)).toBe(planted(WORLD_B));
      // The element is load-bearing: plant a different value and it shows up.
      // Without this the two assertions above would also pass against a twin
      // that answers a constant, which is the mistake one level up.
      expect(served(a.body)).not.toBe(served(b.body));
    }
  );
});

describe("F-1421 — a seeded element is a whole GitHub object, not a stub", () => {
  it("serves the seeded milestone with every field the seed set", async () => {
    const { body } = await get(appFor(WORLD_A), "/repos/acme/api/milestones");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      number: 1,
      title: WORLD_A.milestoneTitle,
      description: "Everything blocking the next tag.",
      state: "open",
      due_on: "2026-09-30T00:00:00Z",
      creator: { login: "pome-agent" },
      open_issues: 0,
      closed_issues: 0
    });
    expect(body[0].html_url).toBe("https://github.com/acme/api/milestone/1");
  });

  it("serves the seeded tag pointed at the ref the seed named", async () => {
    const app = appFor(WORLD_A);
    const { body } = await get(app, "/repos/acme/api/tags");
    const main = await get(app, "/repos/acme/api/branches/main");

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      name: WORLD_A.tagName,
      commit: { sha: main.body.commit.sha }
    });
  });

  it("serves the seeded release, authored by the seeded user and published", async () => {
    const { body } = await get(appFor(WORLD_A), "/repos/acme/api/releases");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      tag_name: WORLD_A.tagName,
      name: `Release ${WORLD_A.tagName}`,
      body: WORLD_A.releaseBody,
      draft: false,
      prerelease: false,
      target_commitish: "main",
      author: { login: "alice" }
    });
    expect(body[0].published_at).toEqual(expect.any(String));
  });

  it("serves the seeded issue comment under its seeded author", async () => {
    const { body } = await get(appFor(WORLD_A), "/repos/acme/api/issues/1/comments");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      body: WORLD_A.issueCommentBody,
      // Not "pome-agent": the write path stamps its own actor, the seed does
      // not, and an issue whose only commenter is the agent under test is not
      // an issue worth handing that agent.
      user: { login: "bob" },
      issue_url: "https://api.github.com/repos/acme/api/issues/1"
    });
  });

  it("serves the seeded review comment anchored to the file the seed named", async () => {
    const { body } = await get(appFor(WORLD_A), "/repos/acme/api/pulls/3/comments");
    expect(body).toHaveLength(1);
    // F-1422 closed the gap this assertion used to record: the LIST served six
    // columns of a row whose `line`, `side` and `commit_id` the CREATE on the
    // same route already served. Both verbs now go through
    // `pullRequestReviewCommentJson`, so the anchor the seed planted is
    // readable from the surface the fidelity lane measures — asserted here on
    // the seeded element, and as the shared-shape property itself in
    // `review-comment-list-shape.test.ts`.
    expect(body[0]).toMatchObject({
      body: WORLD_A.reviewCommentBody,
      path: "src/feature.ts",
      user: { login: "bob" },
      line: 1,
      side: "RIGHT",
      pull_request_url: "https://api.github.com/repos/acme/api/pulls/3"
    });
  });

  // The two below are what pin `path` and `line`: the seed goes through the
  // domain's own write path, so a review comment the API could not have made is
  // a seed that FAILS rather than a row only the seeder can produce. That guard
  // is what makes the served `line` above a fact about the diff rather than a
  // free integer.
  it("refuses a seeded review comment on a file the pull request does not change", async () => {
    const bad = world(WORLD_A);
    // `README.md` is on both branches unchanged, so it is not in the PR's diff.
    bad.repositories[0]!.pull_requests![0]!.review_comments = [
      { body: "nope", path: "README.md", line: 1 }
    ];
    expect(() => createGitHubCloneApp({ seed: bad })).toThrow(/Validation Failed/);
  });

  it("refuses a seeded review comment on a line past the end of the file", async () => {
    const bad = world(WORLD_A);
    // src/feature.ts is one line long.
    bad.repositories[0]!.pull_requests![0]!.review_comments = [
      { body: "nope", path: "src/feature.ts", line: 99 }
    ];
    expect(() => createGitHubCloneApp({ seed: bad })).toThrow(/Validation Failed/);
  });
});

describe("F-1421 — the release surfaces that had no seedable state", () => {
  // `releases/latest` and `releases/tags/:tag` were registered exceptions in
  // pome-cloud's L1 coverage list, reason: "the seed schema cannot seed a
  // release". Both now answer 200 from a seed, so those two exceptions are
  // false and are retired with this change.
  it("serves releases/latest from the seed", async () => {
    const { status, body } = await get(appFor(WORLD_A), "/repos/acme/api/releases/latest");
    expect(status).toBe(200);
    expect(body).toMatchObject({ tag_name: WORLD_A.tagName, body: WORLD_A.releaseBody });
  });

  it("serves releases/tags/:tag from the seed", async () => {
    const { status, body } = await get(
      appFor(WORLD_A),
      `/repos/acme/api/releases/tags/${WORLD_A.tagName}`
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ tag_name: WORLD_A.tagName, body: WORLD_A.releaseBody });
  });

  it("mints no second tag for a release naming a tag the seed already declared", async () => {
    const { body } = await get(appFor(WORLD_A), "/repos/acme/api/tags");
    expect(body.map((tag: { name: string }) => tag.name)).toEqual([WORLD_A.tagName]);
  });

  // F-1533 — the three release surfaces serve one object, so a leaf missing
  // from ONE of them is the whole defect. Asserted per surface rather than on
  // `releaseJson` directly, because a serializer-level test passes while a
  // route serves something else, and it is the ROUTE that the declared lane
  // measures (`topLevelKeys(body[0])` of the committed capture).
  //
  // Neither existing guard catches an omission here, which is why this test is
  // written by hand:
  //   - `satisfies DeepPartial<Release>` permits omitting any field. That is
  //     the point of the anchor — it encodes "faithful SUBSET" — so it fires on
  //     a wrong name or a wrong type and never on a missing one.
  //   - `AssertNoUncovered` in upstream-coverage.types.ts is one-directional:
  //     it reds on an upstream field that is neither emitted nor listed in
  //     `Release_Allow`, and `immutable` was listed. (So was `updated_at`, long
  //     after F-1459 emitted it — a dead allowance the assertion cannot see.)
  //
  // The whole reason this is one test over three surfaces: F-1459 fixed the
  // same serializer for `updated_at` and left no test behind, so the next leaf
  // to go missing had nothing to fail against.
  const RELEASE_SURFACES: Array<{ id: string; path: string; element: (body: any) => any }> = [
    { id: "GET /releases", path: "/repos/acme/api/releases", element: (body) => body[0] },
    { id: "GET /releases/latest", path: "/repos/acme/api/releases/latest", element: (body) => body },
    {
      id: "GET /releases/tags/:tag",
      path: `/repos/acme/api/releases/tags/${WORLD_A.tagName}`,
      element: (body) => body
    }
  ];

  it.each(RELEASE_SURFACES)("serves `immutable` on $id", async ({ path, element }) => {
    const { status, body } = await get(appFor(WORLD_A), path);
    expect(status).toBe(200);
    const release = element(body);
    expect(release).toMatchObject({ tag_name: WORLD_A.tagName });
    // Two assertions, because the defect is the KEY and the value is `false`.
    // `toHaveProperty` first so an omission reports as a missing leaf, which is
    // what it is; on its own, `toBe(false)` against an absent key reads as a
    // value bug and sends the next reader to the wrong place.
    expect(release).toHaveProperty("immutable");
    // `false` is the true value, not a placeholder: this twin models no
    // immutable-release feature and has no route that could enable one, so
    // every release in every reachable state IS mutable.
    expect(release.immutable).toBe(false);
  });

  // The leaf F-1459 added, retro-covered by the same property. It had no test
  // either, and it is one `git revert` away from being the next silent
  // omission on exactly these three surfaces.
  it.each(RELEASE_SURFACES)("serves `updated_at` on $id", async ({ path, element }) => {
    const release = element((await get(appFor(WORLD_A), path)).body);
    expect(release).toHaveProperty("updated_at");
    expect(typeof release.updated_at).toBe("string");
  });

  it("mints the tag for a release whose tag the seed did not declare", async () => {
    const untagged = world(WORLD_A);
    untagged.repositories[0]!.tags = [];
    const { body } = await get(createGitHubCloneApp({ seed: untagged }), "/repos/acme/api/tags");
    expect(body.map((tag: { name: string }) => tag.name)).toEqual([WORLD_A.tagName]);
  });
});

describe("F-1421 — the schema keeps the keys it used to strip", () => {
  it("carries all five entity types through parseSeed", () => {
    const parsed = parseSeed(world(WORLD_A));
    const repo = parsed.repositories[0]!;

    expect(repo.milestones).toHaveLength(1);
    expect(repo.tags).toHaveLength(1);
    expect(repo.releases).toHaveLength(1);
    expect(repo.issues[0]?.comments).toHaveLength(1);
    expect(repo.pull_requests[0]?.review_comments).toHaveLength(1);
  });

  it("keeps a pull request's conversation comments apart from its review comments", async () => {
    // Three things a reader could call "a comment on the PR" (F-1151), and the
    // seed can now express all three separately: the review verdict's prose,
    // the inline comment, and the timeline.
    const seed = world(WORLD_A);
    seed.repositories[0]!.pull_requests![0]!.comments = [
      { body: "Rebased onto main.", author: "alice" }
    ];
    const app = createGitHubCloneApp({ seed });

    const timeline = await get(app, "/repos/acme/api/issues/3/comments");
    const inline = await get(app, "/repos/acme/api/pulls/3/comments");
    const reviews = await get(app, "/repos/acme/api/pulls/3/reviews");

    expect(timeline.body).toHaveLength(1);
    expect(timeline.body[0]).toMatchObject({
      body: "Rebased onto main.",
      user: { login: "alice" },
      // A PR is an issue: GitHub browses its comment at /pull/N while the API
      // pointer stays on the issues path.
      html_url: expect.stringContaining("/acme/api/pull/3#issuecomment-")
    });
    expect(inline.body[0].body).toBe(WORLD_A.reviewCommentBody);
    expect(reviews.body[0].body).toBe(WORLD_A.reviewBody);
  });

  it("leaves the default world alone — the change is additive", () => {
    const parsed = parseSeed(defaultSeedState());
    const repo = parsed.repositories[0]!;
    expect(repo.milestones).toEqual([]);
    expect(repo.tags).toEqual([]);
    expect(repo.releases).toEqual([]);
    expect(repo.issues[0]?.comments).toEqual([]);
  });
});

describe("F-1421 — how the new entities are numbered, scoped and reseeded", () => {
  it("honors milestone numbers the seed pins, in whatever order it pins them", () => {
    // The identity case (`number: 1` first) never exercises the renumber, so
    // this one asks for numbers `nextMilestoneNumber` would not have handed out.
    const seed = world(WORLD_A);
    seed.repositories[0]!.milestones = [
      { number: 7, title: "Later" },
      { number: 2, title: "Earlier" }
    ];
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed(seed);

    expect(domain.listMilestones({ owner: "acme", repo: "api" })).toMatchObject([
      { number: 2, title: "Earlier" },
      { number: 7, title: "Later" }
    ]);
  });

  it("scopes milestones, tags and releases to the repository that declared them", () => {
    const seed = world(WORLD_A);
    seed.repositories.push({
      owner: "acme",
      name: "web",
      default_branch: "main",
      files: [{ path: "README.md", content: "# Web\n" }],
      milestones: [{ title: "web milestone" }],
      tags: [{ name: "web-v0.1.0" }],
      releases: [{ tag_name: "web-v0.1.0", body: "web release" }]
    });
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed(seed);

    const names = (owner: string, repo: string) => ({
      milestones: domain.listMilestones({ owner, repo }).map((m: any) => m.title),
      tags: domain.listTags({ owner, repo }).map((t: any) => t.name),
      releases: domain.listReleases({ owner, repo }).map((r: any) => r.tag_name)
    });

    expect(names("acme", "api")).toEqual({
      milestones: [WORLD_A.milestoneTitle],
      tags: [WORLD_A.tagName],
      releases: [WORLD_A.tagName]
    });
    expect(names("acme", "web")).toEqual({
      milestones: ["web milestone"],
      tags: ["web-v0.1.0"],
      releases: ["web-v0.1.0"]
    });
  });

  it("refuses a seed that declares one tag name twice in a repository", () => {
    const bad = world(WORLD_A);
    bad.repositories[0]!.tags = [{ name: "v1.0.0" }, { name: "v1.0.0", target: "feature" }];
    expect(() => new GitHubDomain(openGitHubCloneDatabase()).seed(bad)).toThrow(
      /declares tag v1\.0\.0 twice/
    );
  });

  it("reseeds from scratch — the counts do not grow across repeated seeds", () => {
    // `/admin/seed` is reseed-from-scratch, and pome-cloud's fidelity sandbox
    // leans on that: it reseeds before every capture and expects the same world.
    // The five new entity types have to be wiped by `resetDatabase` like the
    // rest, or a second capture would run against a doubled world.
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    const counts = () => ({
      milestones: domain.listMilestones({ owner: "acme", repo: "api" }).length,
      tags: domain.listTags({ owner: "acme", repo: "api" }).length,
      releases: domain.listReleases({ owner: "acme", repo: "api" }).length,
      issueComments: domain.listIssueComments({ owner: "acme", repo: "api", issue_number: 1 }).length,
      reviewComments: domain.getPullRequestComments({ owner: "acme", repo: "api", pull_number: 3 }).length
    });

    domain.seed(world(WORLD_A));
    const first = counts();
    domain.seed(world(WORLD_A));

    expect(first).toEqual({ milestones: 1, tags: 1, releases: 1, issueComments: 1, reviewComments: 1 });
    expect(counts()).toEqual(first);
  });
});
