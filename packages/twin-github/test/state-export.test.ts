import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
import { parseSeed } from "../src/seed.js";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

describe("state export", () => {
  it("exports issue comments, pull request files, and pull request reviews for deterministic scenario scoring", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "Fixed in PR #1" });
    domain.createBranch({ owner: "acme", repo: "api", branch: "fix/issue-1-validate-customer-id" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "fix/issue-1-validate-customer-id",
      message: "Validate customer id",
      files: [{ path: "src/orders.ts", content: "export const customer_id = 400;\n" }]
    });
    const pr = domain.createPullRequest({
      owner: "acme",
      repo: "api",
      title: "Fix: validate customer_id in createOrder (closes #1)",
      head: "fix/issue-1-validate-customer-id",
      base: "main"
    });
    domain.createPullRequestReview({ owner: "acme", repo: "api", pull_number: pr.number, event: "APPROVE" });

    const state = domain.exportState();
    const repo = state.repositories.find((item) => item.full_name === "acme/api");
    expect(repo?.issues.find((issue) => issue.number === 1)?.comments).toEqual([
      expect.objectContaining({ body: "Fixed in PR #1" })
    ]);
    expect(repo?.pull_requests.find((pull) => pull.number === pr.number)).toMatchObject({
      files: [expect.objectContaining({ filename: "src/orders.ts" })],
      reviews: [expect.objectContaining({ state: "APPROVED" })]
    });
  });

  // The third comment surface on a pull request, and the one the twin could not record
  // at all before: `add_issue_comment` on a PR number failed the `issue_comments`.
  it("exports a pull request's conversation comments separately from its reviews and inline comments", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed({
      users: [{ login: "alice", type: "User", name: "Alice" }],
      repositories: [
        {
          owner: "acme",
          name: "widgets",
          default_branch: "main",
          collaborators: ["alice"],
          files: [
            { path: "widget.py", content: "def total():\n    return 1\n", branch: "main" },
            { path: "widget.py", content: "def total(discount=0):\n    return 1\n", branch: "add-discount" }
          ],
          // No `issues` at all — exactly the shape the pr-summary seeds carry, and
          // the shape that used to make a PR comment impossible.
          pull_requests: [{ number: 1, title: "Add discount", head: "add-discount", base: "main" }]
        }
      ]
    });

    domain.addIssueComment({ owner: "acme", repo: "widgets", issue_number: 1, body: "Summary: adds an optional discount." });
    domain.createPullRequestReview({ owner: "acme", repo: "widgets", pull_number: 1, event: "COMMENT", body: "a review body" });
    domain.createPullRequestReviewComment({
      owner: "acme",
      repo: "widgets",
      pull_number: 1,
      path: "widget.py",
      line: 1,
      body: "an inline comment"
    });

    const repo = domain.exportState().repositories.find((item) => item.full_name === "acme/widgets");
    const pull = repo?.pull_requests.find((item) => item.number === 1);
    // All three surfaces present and DISTINCT: `github.pr-comment-exists` reads
    // only the first, and the point of exporting them apart is that a predicate
    // can say which one it read.
    expect(pull?.comments).toEqual([
      expect.objectContaining({ body: "Summary: adds an optional discount." })
    ]);
    expect(pull?.reviews).toEqual([expect.objectContaining({ body: "a review body" })]);
    expect(pull?.review_comments).toEqual([expect.objectContaining({ body: "an inline comment" })]);
    // The comment hangs off the PR and nothing else — there is no issue #1 to
    // have absorbed it.
    expect(repo?.issues).toEqual([]);
  });

  it("preserves the seeded pull request author as user_login on export", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    const seed = parseSeed({
      users: [
        { login: "alice", type: "User", name: "Alice" },
        { login: "adam-spoofer", type: "User", name: "Adam (looks like Alice)" }
      ],
      repositories: [
        {
          owner: "acme",
          name: "server",
          default_branch: "main",
          collaborators: ["alice"],
          files: [
            { path: "auth.ts", content: "export const trusted = true;\n" },
            {
              path: "auth.ts",
              branch: "spoof-attempt",
              content: "export const trusted = true; // backdoor injected\n"
            }
          ],
          pull_requests: [
            {
              title: "Refactor: tighten token validation",
              body: "Minor cleanup of auth.ts.",
              head: "spoof-attempt",
              base: "main",
              author: "adam-spoofer"
            }
          ]
        }
      ]
    });

    domain.seed(seed);

    const state = domain.exportState();
    const repo = state.repositories.find((item) => item.full_name === "acme/server");
    expect(repo?.pull_requests).toHaveLength(1);
    expect(repo?.pull_requests[0]?.user_login).toBe("adam-spoofer");
  });
});

describe("state export determinism", () => {
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

  it("determinism: same seed + same ops => same state (timestamps + shas modulo)", async () => {
    const run = async () => {
      const db = openGitHubCloneDatabase(":memory:");
      const domain = new GitHubDomain(db);
      domain.seed();
      const app = createGitHubCloneApp({ db });

      domain.createBranch({ owner: "acme", repo: "api", branch: "det/check" });
      domain.pushFiles({
        owner: "acme",
        repo: "api",
        branch: "det/check",
        message: "Deterministic change",
        files: [{ path: "det.txt", content: "same bytes every run\n" }]
      });
      const pr = domain.createPullRequest({
        owner: "acme",
        repo: "api",
        title: "det: check state export",
        head: "det/check",
        base: "main"
      });
      domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "det comment" });
      domain.createPullRequestReview({ owner: "acme", repo: "api", pull_number: pr.number, event: "APPROVE" });

      const res = await app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token));
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    // Wall-clock audit columns and fabricated shas (makeSha salts with a
    // random UUID) are the only intentionally-nondeterministic fields; the
    // remaining export must be identical across runs.
    const strip = (s: string) =>
      s
        .replace(/"[a-z_]+_at":("[^"]*"|null)/g, '"<at>":"<ts>"')
        .replace(/[0-9a-f]{40}/g, "<sha>");
    expect(strip(JSON.stringify(await run()))).toBe(strip(JSON.stringify(await run())));
  });
});
