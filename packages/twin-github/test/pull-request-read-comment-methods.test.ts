// SPDX-License-Identifier: Apache-2.0
//
// F-1423 — `pull_request_read`'s two comment methods read two different tables.
//
// The dispatch answered BOTH `get_comments` and `get_review_comments` from
// `domain.getPullRequestComments`, i.e. from `pull_request_review_comments`,
// behind a comment claiming the twin "stores one comment thread per PR and
// answers both from it rather than inventing a split it does not model". That
// justification stopped being true: F-1151 gave a PR's CONVERSATION its own
// storage (`issue_comments`, keyed on the PR's number, because GitHub models a
// pull request as an issue), and F-1421 gave the seed both vocabularies as
// separate fields. So the twin does model the split — the tool dispatch just
// read the wrong side of it.
//
// Why it is worth a suite of its own: `pull_request_read` is a tool an EXAMINEE
// calls. An agent that asks for a pull request's discussion and is handed
// inline diff comments is graded against a world that answered a different
// question than the one it asked. Nothing else catches it — the L1 MCP lane
// compares tool names and input schemas, not response bodies, so a wrong-table
// dispatch is invisible to every fidelity lane that runs today.
//
// Every assertion below is on CONTENT, never on a count. Both tables holding
// one row each is precisely the state in which a length assertion passes
// against the bug: `get_comments` returned one element before this fix too, it
// was simply the wrong one. So each method is pinned to the body its own table
// holds, and asserted NOT to carry the other's. `ONLY_CONVERSATION` then
// removes the second table entirely — pre-fix, `get_comments` answered `[]`
// there while the PR visibly had a comment, which is the same defect seen from
// the side where the wrong table is empty rather than merely different.

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

/** The two bodies the whole suite turns on. Nothing else may say either one. */
const CONVERSATION = "Rebased onto main — the flake was the fixture, not the race.";
const INLINE = "This flag needs a default.";

// Issues and pull requests share one per-repo number counter, so the single
// seeded issue is #1 and the pull request is #2. `get_comments` reading the
// issue-comment table by the PR's OWN number is the behaviour under test, so
// the issue below is not scenery: it holds a comment at a DIFFERENT number, and
// a dispatch that leaked across numbers would surface it here.
const PULL = 2;

function world(options: { withInline: boolean }): GitHubStateSeed {
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
        default_branch: "main",
        collaborators: ["alice", "bob", "pome-agent"],
        files: [
          { path: "README.md", content: "# Acme API\n" },
          { path: "src/feature.ts", content: "export const feature = true;\n", branch: "feature" }
        ],
        issues: [
          {
            number: 1,
            title: "Seeded bug: 500 on POST /orders",
            state: "open",
            comments: [{ body: "A comment on the ISSUE, not the pull request.", author: "alice" }]
          }
        ],
        pull_requests: [
          {
            title: "Add feature flag",
            head: "feature",
            base: "main",
            author: "pome-agent",
            comments: [{ body: CONVERSATION, author: "alice" }],
            ...(options.withInline
              ? { review_comments: [{ body: INLINE, path: "src/feature.ts", line: 1, author: "bob" }] }
              : {})
          }
        ]
      }
    ]
  };
}

/** One of each, so neither method can be right by being empty. */
const BOTH_SURFACES = world({ withInline: true });
/** The conversation alone — `get_comments` must not need the other table. */
const ONLY_CONVERSATION = world({ withInline: false });

describe("F-1423 — pull_request_read reads the conversation and the diff separately", () => {
  it("answers get_comments from the PR's conversation, not its review comments", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    const conversation = await call(app, { method: "get_comments" });

    expect(conversation.map((comment) => comment.body)).toEqual([CONVERSATION]);
    expect(JSON.stringify(conversation)).not.toContain(INLINE);
  });

  it("keeps get_review_comments on the review-comment table", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    const inline = await call(app, { method: "get_review_comments" });

    expect(inline.map((comment) => comment.body)).toEqual([INLINE]);
    expect(JSON.stringify(inline)).not.toContain(CONVERSATION);
  });

  // The two methods answering DIFFERENT questions is the whole ticket, so it is
  // asserted directly rather than inferred from the two cases above passing.
  it("serves two disjoint answers for one pull request", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    const conversation = await call(app, { method: "get_comments" });
    const inline = await call(app, { method: "get_review_comments" });

    const bodies = (comments: Comment[]) => comments.map((comment) => comment.body);
    expect(bodies(conversation)).not.toEqual(bodies(inline));
    expect(bodies(conversation).some((body) => bodies(inline).includes(body))).toBe(false);
  });

  // Shape, not just content: the two tables serve two different GitHub schemas,
  // and an agent branching on `path`/`line` is reading the anchor that tells a
  // diff comment from a timeline one. A dispatch that returned the right ROWS
  // through the wrong serializer would pass the body assertions above.
  it("gives each method its own GitHub schema", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    const [conversation] = await call(app, { method: "get_comments" });
    const [inline] = await call(app, { method: "get_review_comments" });

    // A review comment is anchored to a file and a line; a conversation comment
    // has nowhere to be anchored and carries neither key.
    expect(inline).toMatchObject({ path: "src/feature.ts", line: 1 });
    expect(conversation).not.toHaveProperty("path");
    expect(conversation).not.toHaveProperty("line");
    // GitHub browses a PR's conversation comment at `/pull/N#issuecomment-…`
    // even though the API pointer stays on the issues path (F-1151).
    expect(conversation.html_url).toContain(`/acme/api/pull/${PULL}#issuecomment-`);
  });

  it("answers get_comments from a PR that has no review comments at all", async () => {
    const app = createGitHubCloneApp({ seed: ONLY_CONVERSATION });

    expect(await call(app, { method: "get_comments" })).toHaveLength(1);
    // Empty because the table is empty — the one case where both methods
    // returning the same thing is correct, and it must be the EMPTY one.
    expect(await call(app, { method: "get_review_comments" })).toEqual([]);
  });

  // The number is still a PULL REQUEST number. `issue_comments` is shared with
  // issues, and the reader that serves the ISSUE endpoints resolves its target
  // with `requireCommentTarget`, which accepts either entity — right there,
  // wrong here. Every other `pull_request_read` method 404s on a number that is
  // not a PR, and reaching the shared table must not make this one method
  // answer for issues. Issue #1 is seeded WITH a comment precisely so that a
  // dispatch which lost the guard returns it instead of failing.
  it("still refuses a number that is an issue, not a pull request", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    await expect(
      mcp(app, "pull_request_read", { method: "get_comments", owner: "acme", repo: "api", pullNumber: 1 })
    ).rejects.toThrow("404");
    // The sibling method's answer for the same number, so the tool is refusing
    // on one rule rather than two.
    await expect(
      mcp(app, "pull_request_read", { method: "get", owner: "acme", repo: "api", pullNumber: 1 })
    ).rejects.toThrow("404");
  });

  // `pull_request_read(get_comments)` and `issue_read(get_comments)` are the
  // same GitHub endpoint reached by two tool names, because a PR is an issue.
  // They are now two different readers — one guards on the pull request, the
  // other on either entity — so pinning them equal on a PR's number is what
  // stops the pair drifting into two shapes for one comment.
  it("agrees with issue_read's get_comments on the same number", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    const viaPull = await call(app, { method: "get_comments" });
    const viaIssue = (await mcp(app, "issue_read", {
      method: "get_comments",
      owner: "acme",
      repo: "api",
      issue_number: PULL
    })) as Comment[];

    expect(viaPull).toEqual(viaIssue);
  });

  it("paginates the conversation rather than the review comments", async () => {
    const app = createGitHubCloneApp({ seed: BOTH_SURFACES });

    // `perPage: 1` on a one-row table is not a pagination test; what it pins is
    // that the page options reach the SAME reader the method now dispatches to.
    const page = await call(app, { method: "get_comments", perPage: 1, page: 1 });
    expect(page.map((comment) => comment.body)).toEqual([CONVERSATION]);
    expect(await call(app, { method: "get_comments", perPage: 1, page: 2 })).toEqual([]);
  });
});

type Comment = { body: string; html_url: string; path?: string; line?: number };

function call(
  app: ReturnType<typeof createGitHubCloneApp>,
  args: { method: string; page?: number; perPage?: number }
) {
  return mcp(app, "pull_request_read", {
    owner: "acme",
    repo: "api",
    pullNumber: PULL,
    ...args
  }) as Promise<Comment[]>;
}

async function mcp(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  const response = await app.request(
    `${base}/mcp/call`,
    withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args })
    })
  );
  if (!response.ok) throw new Error(`${tool}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<unknown>;
}
