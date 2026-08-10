// SPDX-License-Identifier: Apache-2.0
//
// F-1422 — one row, one shape.
//
// `GET /repos/:o/:r/pulls/:n/comments` built its elements inline out of six
// columns — `{id, path, body, user, created_at, updated_at}` — while `POST` to
// the same route served the SAME ROW through `pullRequestReviewCommentJson`,
// which carries `line`, `side`, `commit_id`, `pull_request_url` and the rest.
// The write path validates `line` against the file's real line count and then
// the read path dropped it. One row had two shapes depending on which verb you
// used, and the read side was the lean one.
//
// It went unmeasured rather than unnoticed: the surface answered `[]` on every
// seed anyone could write until F-1421 made a review comment seedable, and a
// shape-diff returns before the per-element comparison when either side is
// empty. The first real element on this surface is what makes the gap visible —
// as a `field-removed` finding per omitted field, which on a `semantic`-tier
// read surface is drift.
//
// The property under test is stated as the property, not as a field checklist:
// the LIST element and the CREATE response are the same object for the same
// comment. A checklist drifts the moment the serializer gains a field; this
// does not.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * `src/app.ts` exists on BOTH branches and the pull request changes it, so a
 * review comment resolves on either side: `RIGHT` against the four-line head,
 * `LEFT` against the three-line base. The one-line file F-1421's world uses
 * cannot express a wrong line at all — every line in it is line 1.
 */
const BASE_APP_TS = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const HEAD_APP_TS = "const a = 1;\nconst b = 22;\nconst c = 3;\nconst d = 4;\n";

/** What the seed plants on the one review comment. */
type Planted = { line: number; side: "LEFT" | "RIGHT" };

function world(planted: Planted): GitHubStateSeed {
  return {
    users: [
      { login: "acme", type: "Organization", name: "Acme" },
      { login: "bob", type: "User", name: "Bob" },
      { login: "pome-agent", type: "User", name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        default_branch: "main",
        collaborators: ["bob", "pome-agent"],
        files: [
          { path: "README.md", content: "# Acme API\n" },
          { path: "src/app.ts", content: BASE_APP_TS },
          { path: "src/app.ts", content: HEAD_APP_TS, branch: "feature" }
        ],
        pull_requests: [
          {
            title: "Tune the constants",
            body: "Bumps b and adds d.",
            head: "feature",
            base: "main",
            author: "pome-agent",
            review_comments: [
              {
                body: "This constant needs a name.",
                path: "src/app.ts",
                line: planted.line,
                side: planted.side,
                author: "bob"
              }
            ]
          }
        ]
      }
    ]
  };
}

/** No issues in this world, so the pull request is the repo's first number. */
const PR = 1;

function appFor(planted: Planted) {
  return createGitHubCloneApp({ seed: world(planted) });
}

async function req(
  app: ReturnType<typeof createGitHubCloneApp>,
  method: string,
  path: string,
  body?: unknown
) {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(token, init));
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
}

const listComments = (app: ReturnType<typeof createGitHubCloneApp>) =>
  req(app, "GET", `/repos/acme/api/pulls/${PR}/comments`);

describe("F-1422 — the review-comment LIST and CREATE serve one shape", () => {
  it("serves the CREATE response's own field set back from the LIST, for the same comment", async () => {
    const app = appFor({ line: 2, side: "RIGHT" });

    const post = await req(app, "POST", `/repos/acme/api/pulls/${PR}/comments`, {
      body: "Same row, both verbs.",
      path: "src/app.ts",
      line: 4
    });
    expect(post.status).toBe(201);

    const list = await listComments(app);
    expect(list.status).toBe(200);
    const element = list.body.find((comment: { id: number }) => comment.id === post.body.id);
    expect(element).toBeDefined();

    // THE assertion of this ticket. Stated as the property that was violated —
    // one row, one shape — rather than as a list of field names, which would go
    // stale the next time the serializer grows a leaf.
    expect(Object.keys(element).sort()).toEqual(Object.keys(post.body).sort());
    // Same row, same serializer, so the values match too: a LIST that agreed on
    // the key set while answering a different `line` would be the same defect
    // wearing the right shape.
    expect(element).toEqual(post.body);
  });

  it("serves a SEEDED comment through that same shape, not only a POSTed one", async () => {
    // The fidelity lane never POSTs — it seeds and reads. A fix that only held
    // for comments this process created would leave the measured path lean.
    const app = appFor({ line: 2, side: "RIGHT" });
    const post = await req(app, "POST", `/repos/acme/api/pulls/${PR}/comments`, {
      body: "Second comment.",
      path: "src/app.ts",
      line: 4
    });

    const list = await listComments(app);
    expect(list.body).toHaveLength(2);
    const [seeded, posted] = list.body;
    expect(posted.id).toBe(post.body.id);
    expect(Object.keys(seeded).sort()).toEqual(Object.keys(post.body).sort());
  });

  it("carries the four fields the row already held and the read used to drop", async () => {
    const app = appFor({ line: 2, side: "RIGHT" });
    const head = await req(app, "GET", "/repos/acme/api/branches/feature");
    const list = await listComments(app);

    expect(list.body[0]).toMatchObject({
      // The named four (ticket F-1422).
      line: 2,
      side: "RIGHT",
      commit_id: head.body.commit.sha,
      pull_request_url: `https://api.github.com/repos/acme/api/pulls/${PR}`,
      // The six that were already there stay there — this widened the shape, it
      // did not swap it.
      path: "src/app.ts",
      body: "This constant needs a name.",
      user: { login: "bob" }
    });
    expect(list.body[0].created_at).toEqual(expect.any(String));
    expect(list.body[0].updated_at).toEqual(expect.any(String));
    expect(list.body[0].id).toEqual(expect.any(Number));
  });

  it("anchors a LEFT-side comment to the base file's line", async () => {
    // `side` is not decoration: it selects which file the write path measures
    // `line` against. Serving it is what lets a reader know which side of the
    // diff the comment sits on.
    const list = await listComments(appFor({ line: 3, side: "LEFT" }));
    expect(list.body[0]).toMatchObject({ line: 3, side: "LEFT" });
  });
});

describe("F-1422 — a wrong line is drift, not a field nobody reads", () => {
  // A field that is serialized but never COMPARED is the same defect one level
  // over: it publishes green whatever it holds. These two worlds differ in one
  // planted value and nothing else, so the served element has to move with it.
  it("serves the line THIS seed planted, and a different seed a different one", async () => {
    const right = await listComments(appFor({ line: 2, side: "RIGHT" }));
    // Line 4 exists only on the head file (the base is three lines long), so
    // this is a value the other world could not have produced by accident.
    const wrong = await listComments(appFor({ line: 4, side: "RIGHT" }));

    expect(right.body[0].line).toBe(2);
    expect(wrong.body[0].line).toBe(4);
    expect(right.body[0].line).not.toBe(wrong.body[0].line);

    // `position` and `original_line` are resolved from the same row column, so
    // a comparison catches the wrong line through all three.
    expect(wrong.body[0]).toMatchObject({ line: 4, original_line: 4, position: 4 });
  });

  it("serves the side THIS seed planted, and a different seed a different one", async () => {
    const right = await listComments(appFor({ line: 3, side: "RIGHT" }));
    const left = await listComments(appFor({ line: 3, side: "LEFT" }));

    expect(right.body[0].side).toBe("RIGHT");
    expect(left.body[0].side).toBe("LEFT");
    expect(right.body[0].side).not.toBe(left.body[0].side);
  });

  it("refuses a seeded line past the end of the side it names", async () => {
    // The write path's own guard, restated here because it is what makes the
    // served `line` worth comparing: the twin cannot hold a line the file does
    // not have, so a served `line` is a fact about the diff and not a free
    // integer. `LEFT` is the three-line base; line 4 exists only on the head.
    expect(() => appFor({ line: 4, side: "LEFT" })).toThrow(/Validation Failed/);
  });
});
