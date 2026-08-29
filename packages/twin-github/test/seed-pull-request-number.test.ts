// SPDX-License-Identifier: Apache-2.0
//
// A seeded pull request gets the number the seed asked for.
//
// `seedSchema` has accepted `number` on a pull request since the field existed;
// the applier called `createPullRequest` and kept whatever `nextNumber()` handed
// out. Measured 2026-08-29: a repo seeded with issue `number: 1` and pull request
// `number: 7` exported issues `[1]` and pulls `[2]`.
//
// The failure that produces is not a missing check. Criteria resolve a pull
// request BY NUMBER, so a criterion naming #7 either fails at lookup with
// `pull request #7 not found` — which reads like an agent defect — or, worse,
// resolves to whatever #7 happens to be and grades the wrong pull request
// confidently. Six `github.pr-comment-exists` criteria in `agent-examples/` ride
// on the coincidence today: their seeds carry `issues: []` and list pull requests
// in ascending order, so the shared `entity_counter` happens to hand out the
// numbers they asked for.
//
// `createIssue` right next to it already did this correctly. This is that path,
// for pull requests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
import { parseSeed } from "../src/seed.js";
import { createGitHubCloneApp } from "../src/twin.js";
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

/** The ticket's `Do:` — one issue #1, one pull request #7, every child a
 *  renumber could orphan. */
const WORLD = {
  users: [
    { login: "vakoi", type: "Organization", name: "Vakoi" },
    { login: "alice", type: "User", name: "Alice" },
    { login: "bob", type: "User", name: "Bob" },
  ],
  repositories: [
    {
      owner: "vakoi",
      name: "billing",
      collaborators: ["alice", "bob"],
      files: [
        { path: "README.md", content: "# Billing\n" },
        { path: "src/dunning.ts", content: "export const retries = 3;\n", branch: "retry-window" },
      ],
      issues: [{ number: 1, title: "Dunning retries fire twice", comments: [{ body: "on the issue", author: "alice" }] }],
      pull_requests: [
        {
          number: 7,
          title: "Cap the dunning retry window",
          head: "retry-window",
          author: "alice",
          reviews: [{ author: "bob", state: "CHANGES_REQUESTED", body: "one blocker" }],
          statuses: [{ context: "ci/dunning", state: "failure", description: "2 of 41 failing" }],
          comments: [{ body: "on the pull request", author: "alice" }],
          review_comments: [{ body: "drop the sleep", path: "src/dunning.ts", line: 1, author: "bob" }],
        },
      ],
    },
  ],
};

function seeded(seed: unknown = WORLD): GitHubDomain {
  const domain = new GitHubDomain(openGitHubCloneDatabase(":memory:"));
  domain.seed(parseSeed(seed) as GitHubStateSeed);
  return domain;
}

async function get(app: ReturnType<typeof createGitHubCloneApp>, path: string) {
  const response = await app.request(`${base}${path}`, withAuth(token));
  return { status: response.status, body: (await response.json()) as any };
}

describe("the number the seed asked for is the number the world has", () => {
  it("exportState: issues [1], pulls [7]", () => {
    const state = seeded().exportState() as unknown as {
      repositories: Array<{
        issues: Array<{ number: number }>;
        pull_requests: Array<{ number: number }>;
      }>;
    };
    const repo = state.repositories[0]!;
    expect(repo.issues.map((issue) => issue.number)).toEqual([1]);
    expect(repo.pull_requests.map((pull) => pull.number)).toEqual([7]);
  });

  it("GET /repos/:o/:r/pulls/7 serves it; #2 is not found", async () => {
    const app = createGitHubCloneApp({ seed: parseSeed(WORLD) as GitHubStateSeed });
    const found = await get(app, "/repos/vakoi/billing/pulls/7");
    expect(found.status).toBe(200);
    expect(found.body.title).toBe("Cap the dunning retry window");
    expect((await get(app, "/repos/vakoi/billing/pulls/2")).status).toBe(404);
  });
});

// "A missed table is a silent orphan" — every child keyed to the pull request's
// number, asked for at the number the seed named.
describe("every child rides the renumber", () => {
  let app: ReturnType<typeof createGitHubCloneApp>;
  beforeAll(() => {
    app = createGitHubCloneApp({ seed: parseSeed(WORLD) as GitHubStateSeed });
  });

  it("pull_request_files — GET /pulls/7/files", async () => {
    const { status, body } = await get(app, "/repos/vakoi/billing/pulls/7/files");
    expect(status).toBe(200);
    expect((body as Array<{ filename: string }>).map((file) => file.filename)).toContain(
      "src/dunning.ts",
    );
  });

  it("pull_request_reviews — GET /pulls/7/reviews", async () => {
    const { status, body } = await get(app, "/repos/vakoi/billing/pulls/7/reviews");
    expect(status).toBe(200);
    expect((body as Array<{ body: string; state: string }>)[0]).toMatchObject({
      body: "one blocker",
      state: "CHANGES_REQUESTED",
    });
  });

  it("pull_request_review_comments — GET /pulls/7/comments", async () => {
    const { status, body } = await get(app, "/repos/vakoi/billing/pulls/7/comments");
    expect(status).toBe(200);
    expect((body as Array<{ body: string }>).map((row) => row.body)).toEqual(["drop the sleep"]);
  });

  it("issue_comments — GET /issues/7/comments, the PR's own timeline", async () => {
    const { status, body } = await get(app, "/repos/vakoi/billing/issues/7/comments");
    expect(status).toBe(200);
    expect((body as Array<{ body: string }>).map((row) => row.body)).toEqual([
      "on the pull request",
    ]);
  });

  it("commit_statuses — GET /pulls/7/status", async () => {
    const { status, body } = await get(app, "/repos/vakoi/billing/pulls/7/status");
    expect(status).toBe(200);
    expect(body.state).toBe("failure");
  });

  it("the issue's own comments did not move with it", async () => {
    const { body } = await get(app, "/repos/vakoi/billing/issues/1/comments");
    expect((body as Array<{ body: string }>).map((row) => row.body)).toEqual(["on the issue"]);
  });
});

// Issues and pull requests share ONE per-repo counter, so a later insert must
// not land on a number the seed already claimed.
describe("the counter moves with the renumber", () => {
  it("a pull request created after a seeded #7 gets #8, not #3", () => {
    const domain = seeded();
    domain.createBranch({ owner: "vakoi", repo: "billing", branch: "hotfix", from_branch: "main" });
    domain.createOrUpdateFile({
      owner: "vakoi",
      repo: "billing",
      path: "src/hotfix.ts",
      message: "hotfix",
      content: "export const x = 1;\n",
      branch: "hotfix",
    });
    const created = domain.createPullRequest({
      owner: "vakoi",
      repo: "billing",
      title: "after",
      head: "hotfix",
      base: "main",
    }) as { number: number };
    expect(created.number).toBe(8);
  });

  it("an issue created after a seeded #7 gets #8 too — one counter, both kinds", () => {
    const domain = seeded();
    const created = domain.createIssue({
      owner: "vakoi",
      repo: "billing",
      title: "after",
    }) as { number: number };
    expect(created.number).toBe(8);
  });
});

// There is no correct silent resolution: within a repo a number names an issue
// or a pull request, never both. So it is refused where the author can still see
// their own file — at parse.
describe("a number claimed twice is refused at parse, naming both entities", () => {
  it("a pull request colliding with an issue", () => {
    expect(() =>
      parseSeed({
        repositories: [
          {
            owner: "vakoi",
            name: "billing",
            issues: [{ number: 3, title: "issue three" }],
            pull_requests: [{ number: 3, title: "pull three", head: "feature" }],
          },
        ],
      }),
    ).toThrow(/issues\[0\][\s\S]*pull_requests\[0\]|pull_requests\[0\][\s\S]*issues\[0\]/);
  });

  it("names the number itself, so the author can search for it", () => {
    expect(() =>
      parseSeed({
        repositories: [
          {
            owner: "vakoi",
            name: "billing",
            issues: [{ number: 3, title: "issue three" }],
            pull_requests: [{ number: 3, title: "pull three", head: "feature" }],
          },
        ],
      }),
    ).toThrow(/\b3\b/);
  });

  it("two pull requests claiming one number", () => {
    expect(() =>
      parseSeed({
        repositories: [
          {
            owner: "vakoi",
            name: "billing",
            pull_requests: [
              { number: 5, title: "a", head: "a" },
              { number: 5, title: "b", head: "b" },
            ],
          },
        ],
      }),
    ).toThrow(/pull_requests\[0\][\s\S]*pull_requests\[1\]/);
  });

  it("two issues claiming one number", () => {
    expect(() =>
      parseSeed({
        repositories: [
          {
            owner: "vakoi",
            name: "billing",
            issues: [
              { number: 5, title: "a" },
              { number: 5, title: "b" },
            ],
          },
        ],
      }),
    ).toThrow(/issues\[0\][\s\S]*issues\[1\]/);
  });

  it("but the same number in two DIFFERENT repositories is fine", () => {
    expect(() =>
      parseSeed({
        repositories: [
          { owner: "vakoi", name: "billing", issues: [{ number: 3, title: "a" }] },
          { owner: "vakoi", name: "dunning", pull_requests: [{ number: 3, title: "b", head: "f" }] },
        ],
      }),
    ).not.toThrow();
  });

  it("and a seed that numbers nothing is still fine", () => {
    expect(() =>
      parseSeed({
        repositories: [
          {
            owner: "vakoi",
            name: "billing",
            issues: [{ title: "a" }, { title: "b" }],
            pull_requests: [{ title: "c", head: "f" }],
          },
        ],
      }),
    ).not.toThrow();
  });
});

// The four `pr-summary-*` seeds pass today only by coincidence — ascending order
// and `issues: []`. The renumber must not move a number that was already right.
describe("a seed the accident already served correctly is unchanged", () => {
  it("ascending pull requests with no issues still get 1, 2", () => {
    const state = seeded({
      repositories: [
        {
          owner: "vakoi",
          name: "billing",
          files: [
            { path: "README.md", content: "# Billing\n" },
            { path: "a.ts", content: "export const a = 1;\n", branch: "a" },
            { path: "b.ts", content: "export const b = 1;\n", branch: "b" },
          ],
          issues: [],
          pull_requests: [
            { number: 1, title: "first", head: "a" },
            { number: 2, title: "second", head: "b" },
          ],
        },
      ],
    }).exportState() as unknown as {
      repositories: Array<{ pull_requests: Array<{ number: number; title: string }> }>;
    };
    expect(state.repositories[0]!.pull_requests.map((pull) => [pull.number, pull.title])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
  });

  it("a pull request with no `number` still takes the next one", () => {
    const state = seeded({
      repositories: [
        {
          owner: "vakoi",
          name: "billing",
          files: [
            { path: "README.md", content: "# Billing\n" },
            { path: "a.ts", content: "export const a = 1;\n", branch: "a" },
          ],
          issues: [{ number: 4, title: "four" }],
          pull_requests: [{ title: "unnumbered", head: "a" }],
        },
      ],
    }).exportState() as unknown as {
      repositories: Array<{ pull_requests: Array<{ number: number }> }>;
    };
    expect(state.repositories[0]!.pull_requests.map((pull) => pull.number)).toEqual([5]);
  });
});
