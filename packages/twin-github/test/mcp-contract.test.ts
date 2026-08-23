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
  it("lists and executes all 36 GitHub twin tools, in the capture's order", async () => {
    const app = createGitHubCloneApp();
    // ORDER IS THE CAPTURE'S, not this twin's.
    expect([...githubToolFixture.toolNames]).toEqual([
      "add_issue_comment",
      "add_reply_to_pull_request_comment",
      "create_branch",
      "create_or_update_file",
      "create_pull_request",
      "create_repository",
      "delete_file",
      "fork_repository",
      "get_commit",
      "get_file_contents",
      "get_latest_release",
      "get_me",
      "get_release_by_tag",
      "get_tag",
      "issue_read",
      "issue_write",
      "list_branches",
      "list_commits",
      "list_issues",
      "list_pull_requests",
      "list_releases",
      "list_repository_collaborators",
      "list_tags",
      "merge_pull_request",
      "pull_request_read",
      "pull_request_review_write",
      "push_files",
      "search_code",
      "search_commits",
      "search_issues",
      "search_repositories",
      "search_users",
      "update_pull_request",
      "update_pull_request_branch",
      // The two rows the capture cannot carry, appended by the producer:
      // GitHub gates these behind the `issues_granular` / `pull_requests_granular`
      // feature flags and the golden is captured with none set (GITHUB-MCP-001/002).
      "create_issue",
      "create_pull_request_review",
    ]);

    await call(app, "search_repositories", { query: "acme" });
    await call(app, "create_repository", { owner: "qa", name: "repo" });
    await call(app, "fork_repository", { owner: "acme", repo: "api", organization: "forks" });
    await call(app, "search_code", { query: "handler" });
    await call(app, "search_users", { query: "alice" });
    await call(app, "get_file_contents", { owner: "acme", repo: "api", path: "README.md" });
    await call(app, "list_commits", { owner: "acme", repo: "api" });
    // `branch` is required since — GitHub declares it required on this tool and the
    // twin took it as optional, which let an examinee write to a default branch.
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "main", path: "contract.txt", message: "Add contract", content: "ok\n" });
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "contract" });
    await call(app, "push_files", { owner: "acme", repo: "api", branch: "contract", message: "Change", files: [{ path: "contract.txt", content: "changed\n" }] });
    // issue_read / issue_write — every method this twin answers.
    await call(app, "issue_read", { method: "get", owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "issue_read", { method: "get_comments", owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "issue_read", { method: "get_labels", owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "issue_write", { method: "update", owner: "acme", repo: "api", issue_number: 1, state: "open" });
    await call(app, "issue_write", { method: "create", owner: "acme", repo: "api", title: "Consolidated issue" });
    await call(app, "search_issues", { query: "500" });
    // GitHub's MCP enum is ["OPEN","CLOSED"] with no `all` member, and its own
    // description says both are returned when the argument is absent — so "everything".
    await call(app, "list_issues", { owner: "acme", repo: "api" });
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

    // ===== v2 hot paths ======================================
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
    // Inline review comments are a REST-only surface since —
    // `create_pull_request_review_comment` is not a tool GitHub declares — so the reply tool, which IS.
    const inline = await rest(app, "POST", `/repos/acme/api/pulls/${pr2.number}/comments`, { body: "Nit", path: "feature.ts", line: 1 });
    await call(app, "add_reply_to_pull_request_comment", { owner: "acme", repo: "api", pull_number: pr2.number, comment_id: inline.id, body: "Fixed" });
    // Releases: `create_release` is REST-only for the same reason, and the two
    // release readers that ARE tools need something to read.
    await rest(app, "POST", "/repos/acme/api/releases", { tag_name: "v1.0.0", name: "First", body: "Initial release" });
    await call(app, "list_tags", { owner: "acme", repo: "api" });
    await call(app, "list_releases", { owner: "acme", repo: "api" });
    await call(app, "get_latest_release", { owner: "acme", repo: "api" });
    // M5 hot gaps
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
  // GitHub's own schema uses, and the only one they accept.
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

  // `add_collaborator` stopped being an MCP tool — GitHub declares no such tool — but
  // the operation, and every guard on it, is unchanged on the REST door these.
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
