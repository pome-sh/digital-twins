import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { githubToolFixture } from "../src/tools.js";
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

describe("MCP tool contract", () => {
  it("lists and executes all 65 GitHub twin tools", async () => {
    const app = createGitHubCloneApp();
    expect([...githubToolFixture.toolNames]).toEqual([
      "search_repositories",
      "create_repository",
      "fork_repository",
      "search_code",
      "search_users",
      "get_file_contents",
      "list_commits",
      "create_or_update_file",
      "create_branch",
      "push_files",
      // GitHub's consolidated issue pair (F-1376)
      "issue_read",
      "issue_write",
      "search_issues",
      "list_issues",
      "add_issue_comment",
      "create_issue",
      "list_repository_collaborators",
      // GitHub's consolidated pull-request pair (F-1376)
      "pull_request_read",
      "pull_request_review_write",
      "create_pull_request_review",
      "list_pull_requests",
      "merge_pull_request",
      "update_pull_request_branch",
      "create_pull_request",
      // v2 hot paths (FDRS-300)
      "list_branches",
      "delete_file",
      "get_commit",
      "update_pull_request",
      "add_reply_to_pull_request_comment",
      "list_tags",
      "list_releases",
      "get_latest_release",
      "get_me",
      // M5 hot gaps (F-735)
      "search_commits",
      "get_release_by_tag",
      "get_tag"
    ]);

    await call(app, "search_repositories", { query: "acme" });
    await call(app, "create_repository", { owner: "qa", name: "repo" });
    await call(app, "fork_repository", { owner: "acme", repo: "api", organization: "forks" });
    await call(app, "search_code", { query: "handler" });
    await call(app, "search_users", { query: "alice" });
    await call(app, "get_file_contents", { owner: "acme", repo: "api", path: "README.md" });
    await call(app, "list_commits", { owner: "acme", repo: "api" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", path: "contract.txt", message: "Add contract", content: "ok\n" });
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "contract" });
    await call(app, "push_files", { owner: "acme", repo: "api", branch: "contract", message: "Change", files: [{ path: "contract.txt", content: "changed\n" }] });
    // issue_read / issue_write — every method this twin answers.
    await call(app, "issue_read", { method: "get", owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "issue_read", { method: "get_comments", owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "issue_read", { method: "get_labels", owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "issue_write", { method: "update", owner: "acme", repo: "api", issue_number: 1, state: "open" });
    await call(app, "issue_write", { method: "create", owner: "acme", repo: "api", title: "Consolidated issue" });
    await call(app, "search_issues", { query: "500" });
    await call(app, "list_issues", { owner: "acme", repo: "api", state: "all" });
    await call(app, "add_issue_comment", { owner: "acme", repo: "api", issue_number: 1, body: "contract comment" });
    await call(app, "create_issue", { owner: "acme", repo: "api", title: "Contract issue" });
    await call(app, "list_repository_collaborators", { owner: "acme", repo: "api" });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Contract PR", head: "contract", base: "main" });
    // pull_request_read — every method this twin answers.
    for (const method of ["get", "get_diff", "get_status", "get_files", "get_commits", "get_reviews", "get_comments", "get_review_comments", "get_check_runs"]) {
      await call(app, "pull_request_read", { method, owner: "acme", repo: "api", pullNumber: pr.number });
    }
    await call(app, "pull_request_review_write", { method: "create", owner: "acme", repo: "api", pullNumber: pr.number, event: "COMMENT", body: "consolidated review" });
    await call(app, "create_pull_request_review", { owner: "acme", repo: "api", pull_number: pr.number, event: "COMMENT", body: "contract review" });
    await call(app, "list_pull_requests", { owner: "acme", repo: "api", state: "all" });
    await call(app, "update_pull_request_branch", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "merge_pull_request", { owner: "acme", repo: "api", pull_number: pr.number });

    // ===== v2 hot paths (FDRS-300) ======================================
    await call(app, "list_branches", { owner: "acme", repo: "api" });
    // Throwaway branch + file so delete_file has something to operate on.
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "scratch" });
    const scratch = await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "scratch", path: "scratch.txt", message: "Scratch", content: "x\n" });
    await call(app, "delete_file", { owner: "acme", repo: "api", branch: "scratch", path: "scratch.txt", message: "Drop scratch", sha: scratch.content.sha });
    const commits = await call(app, "list_commits", { owner: "acme", repo: "api" });
    const head = commits[0].sha;
    await call(app, "get_commit", { owner: "acme", repo: "api", ref: head });
    // A fresh open PR for the update tests, since the original was merged.
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "feature-2" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "feature-2", path: "feature.ts", message: "Add feature", content: "export const ok = true;\n" });
    const pr2 = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Feature 2", head: "feature-2", base: "main" });
    await call(app, "update_pull_request", { owner: "acme", repo: "api", pull_number: pr2.number, title: "Feature 2 (updated)" });
    // Inline review comments are a REST-only surface since F-1376 —
    // `create_pull_request_review_comment` is not a tool GitHub declares — so the
    // reply tool, which IS, is seeded through the REST door.
    const inline = await rest(app, "POST", `/repos/acme/api/pulls/${pr2.number}/comments`, { body: "Nit", path: "feature.ts", line: 1 });
    await call(app, "add_reply_to_pull_request_comment", { owner: "acme", repo: "api", pull_number: pr2.number, comment_id: inline.id, body: "Fixed" });
    // Releases: `create_release` is REST-only for the same reason, and the two
    // release readers that ARE tools need something to read.
    await rest(app, "POST", "/repos/acme/api/releases", { tag_name: "v1.0.0", name: "First", body: "Initial release" });
    await call(app, "list_tags", { owner: "acme", repo: "api" });
    await call(app, "list_releases", { owner: "acme", repo: "api" });
    await call(app, "get_latest_release", { owner: "acme", repo: "api" });
    // M5 hot gaps (F-735)
    await call(app, "search_commits", { query: "contract" });
    await call(app, "get_release_by_tag", { owner: "acme", repo: "api", tag: "v1.0.0" });
    await call(app, "get_tag", { owner: "acme", repo: "api", tag: "v1.0.0" });
    await call(app, "get_me", {});
  });

  it("accepts camelCase pullNumber aliases for v2 PR tools", async () => {
    const app = createGitHubCloneApp();
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "camel-pr" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "camel-pr", path: "camel.ts", message: "camel", content: "export const camel = true;\n" });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Camel PR", head: "camel-pr", base: "main" });

    await call(app, "update_pull_request", { owner: "acme", repo: "api", pullNumber: pr.number, title: "Camel PR updated" });
    const inline = await rest(app, "POST", `/repos/acme/api/pulls/${pr.number}/comments`, { body: "Nit", path: "camel.ts", line: 1 });
    await call(app, "add_reply_to_pull_request_comment", { owner: "acme", repo: "api", pullNumber: pr.number, commentId: inline.id, body: "Done" });
  });

  // `pullNumber` is not an alias on the consolidated readers — it is the spelling
  // GitHub's own schema uses, and the only one they accept (F-1376).
  it("takes GitHub's pullNumber spelling on the consolidated PR tools", async () => {
    const app = createGitHubCloneApp();
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "camel-read" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "camel-read", path: "read.ts", message: "read", content: "export const read = true;\n" });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Camel read", head: "camel-read", base: "main" });

    const got = await call(app, "pull_request_read", { method: "get", owner: "acme", repo: "api", pullNumber: pr.number });
    expect(got.number).toBe(pr.number);
    await expect(
      call(app, "pull_request_read", { method: "get", owner: "acme", repo: "api", pull_number: pr.number })
    ).rejects.toThrow("422");
  });

  it("legacy MCP get_me returns the authenticated token identity", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const me = await call(app, "get_me", {}, aliceToken);
    expect(me.login).toBe("alice");
  });

  // `add_collaborator` stopped being an MCP tool in F-1376 — GitHub declares no
  // such tool — but the operation, and every guard on it, is unchanged on the
  // REST door these now drive. The guard was never MCP-only: `routes.ts` runs the
  // same `hasRepositoryPermission` check the tool dispatch used to.
  it("REST add_collaborator uses the authenticated token identity as inviter", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const result = await rest(app, "PUT", "/repos/acme/api/collaborators/invitee", { permission: "push" }, aliceToken);
    expect(result.inviter.login).toBe("alice");
  });

  it("REST add_collaborator requires repository write access", async () => {
    const app = createGitHubCloneApp();
    const outsiderToken = await signTestToken({ login: "mallory" });
    await expect(
      rest(app, "PUT", "/repos/acme/api/collaborators/invitee", { permission: "push" }, outsiderToken)
    ).rejects.toThrow("403");
  });

  it("REST add_collaborator does not treat pending invitations as write access", async () => {
    const app = createGitHubCloneApp();
    await rest(app, "PUT", "/repos/acme/api/collaborators/pending-user", { permission: "push" });
    const pendingToken = await signTestToken({ login: "pending-user" });

    await expect(
      rest(app, "PUT", "/repos/acme/api/collaborators/invitee", { permission: "push" }, pendingToken)
    ).rejects.toThrow("403");
  });

  it("legacy MCP merge_pull_request requires collaborator access", async () => {
    const app = createGitHubCloneApp();
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "outsider-merge" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "outsider-merge", path: "outsider.ts", message: "outsider", content: "export const outsider = true;\n" });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Outsider merge", head: "outsider-merge", base: "main" });
    const outsiderToken = await signTestToken({ login: "mallory" });

    await expect(call(app, "merge_pull_request", { owner: "acme", repo: "api", pull_number: pr.number }, outsiderToken)).rejects.toThrow("403");
  });
});

async function call(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown, authToken = token) {
  const response = await app.request(`${base}/mcp/call`, withAuth(authToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, arguments: args })
  }));
  if (!response.ok) throw new Error(`${tool}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

async function rest(
  app: ReturnType<typeof createGitHubCloneApp>,
  method: string,
  path: string,
  body?: unknown,
  authToken = token
) {
  const response = await app.request(`${base}${path}`, withAuth(authToken, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
