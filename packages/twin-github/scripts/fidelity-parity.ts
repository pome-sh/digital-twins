// SPDX-License-Identifier: Apache-2.0
//
// fidelity:parity — declarative parity scenario for twin-github (F-730).
// The runner lives in @pome-sh/sdk/parity; this file is scenario data only:
// an ordered, stateful chain that exercises every MCP tool in
// fidelity.inventory.json against the seeded acme/api world, plus the
// loud-501 REST probe and optional read-only live-shape probes via `gh api`
// (set GITHUB_PARITY_REPO=owner/repo).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadFidelityInventory, runParityCli, type ParityStep } from "@pome-sh/sdk/parity";
import { createGitHubCloneApp } from "../src/twin.js";
import { githubToolFixture } from "../src/tools.js";

const repo = { owner: "acme", repo: "api" };

const steps: ParityStep[] = [
  // Reads against the seeded world
  { tool: "search_repositories", arguments: { query: "acme" } },
  { tool: "search_code", arguments: { query: "handler" } },
  { tool: "search_users", arguments: { query: "alice" } },
  { tool: "get_file_contents", arguments: { ...repo, path: "README.md" } },
  { tool: "list_commits", arguments: { ...repo } },
  {
    tool: "list_branches",
    arguments: { ...repo },
    capture: (body, state) => {
      const main = (body as Array<{ name?: string; commit?: { sha?: string } }>).find((b) => b.name === "main");
      state.mainSha = main?.commit?.sha;
    },
  },
  // Repositories + branches + files
  { tool: "create_repository", arguments: { owner: "qa", name: "parity" } },
  { tool: "fork_repository", arguments: { ...repo, organization: "forks" } },
  // `branch` is required since F-1468 — GitHub declares it required and the
  // twin took it as optional, which let a write land on a branch nobody named.
  { tool: "create_or_update_file", arguments: { ...repo, branch: "main", path: "parity.txt", message: "Add parity", content: "ok\n" } },
  { tool: "create_branch", arguments: { ...repo, branch: "parity" } },
  { tool: "push_files", arguments: { ...repo, branch: "parity", message: "Change parity", files: [{ path: "parity.txt", content: "changed\n" }] } },
  // Advance main past the branch point so update_pull_request_branch has work
  {
    tool: "create_or_update_file",
    arguments: { ...repo, branch: "main", path: "delete-me.txt", message: "Add delete-me", content: "bye\n" },
    capture: (body, state) => {
      state.deleteMeSha = (body as { content?: { sha?: string } }).content?.sha;
    },
  },
  { tool: "delete_file", arguments: (state) => ({ ...repo, branch: "main", path: "delete-me.txt", message: "Remove delete-me", sha: state.deleteMeSha }) },
  { tool: "get_commit", arguments: { ...repo, ref: "main" } },
  // Issues — GitHub's consolidated pair, every method this twin answers
  { tool: "issue_read", arguments: { method: "get", ...repo, issue_number: 1 } },
  { tool: "issue_read", arguments: { method: "get_comments", ...repo, issue_number: 1 } },
  { tool: "issue_read", arguments: { method: "get_labels", ...repo, issue_number: 1 } },
  { tool: "issue_write", arguments: { method: "update", ...repo, issue_number: 1, state: "open" } },
  { tool: "issue_write", arguments: { method: "create", ...repo, title: "Parity issue via issue_write" } },
  { tool: "search_issues", arguments: { query: "500" } },
  // No `state` (F-1468). GitHub's MCP enum here is ["OPEN","CLOSED"] with no
  // `all`, and its description says both are returned when the argument is
  // absent — so omission is how "all" is spelled on this door. Note the NEXT
  // line up: `issue_write.state` is lowercase ["open","closed"], because that is
  // what GitHub declares THERE. Three spellings on one vendor; the twin follows
  // each, and mcp-state-enum.test.ts pins the difference against the capture.
  { tool: "list_issues", arguments: { ...repo } },
  { tool: "add_issue_comment", arguments: { ...repo, issue_number: 1, body: "Parity comment" } },
  { tool: "create_issue", arguments: { ...repo, title: "Parity issue" } },
  // Collaborators + identity
  { tool: "list_repository_collaborators", arguments: { ...repo } },
  { tool: "get_me" },
  // Pull request chain
  {
    tool: "create_pull_request",
    arguments: { ...repo, title: "Parity PR", head: "parity", base: "main" },
    capture: (body, state) => {
      state.pullNumber = (body as { number?: number }).number;
    },
  },
  // pull_request_read — every method this twin answers, one step each, so a
  // method wired to the wrong domain call is a named failure rather than a hole.
  ...["get", "get_diff", "get_status", "get_files", "get_commits", "get_reviews", "get_comments", "get_review_comments", "get_check_runs"].map(
    (method): ParityStep => ({
      tool: "pull_request_read",
      arguments: (state) => ({ method, ...repo, pullNumber: state.pullNumber }),
    })
  ),
  { tool: "create_pull_request_review", arguments: (state) => ({ ...repo, pull_number: state.pullNumber, event: "APPROVE" }) },
  { tool: "pull_request_review_write", arguments: (state) => ({ method: "create", ...repo, pullNumber: state.pullNumber, event: "COMMENT", body: "Parity review via the consolidated writer" }) },
  // GitHub declares no `create_pull_request_review_comment` MCP tool (F-1376),
  // so the reply tool's subject is built over the REST route the twin still
  // serves. Not coverage — `add_reply_to_pull_request_comment` below is.
  {
    setup: { method: "POST", path: (state) => `/repos/acme/api/pulls/${String(state.pullNumber)}/comments` },
    arguments: { body: "Inline parity", path: "parity.txt", line: 1 },
    capture: (body, state) => {
      state.reviewCommentId = (body as { id?: number }).id;
    },
  },
  { tool: "add_reply_to_pull_request_comment", arguments: (state) => ({ ...repo, pull_number: state.pullNumber, comment_id: state.reviewCommentId, body: "Parity reply" }) },
  { tool: "list_pull_requests", arguments: { ...repo, state: "all" } },
  { tool: "update_pull_request", arguments: (state) => ({ ...repo, pull_number: state.pullNumber, title: "Parity PR (renamed)" }) },
  { tool: "update_pull_request_branch", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "merge_pull_request", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  // Tags + releases. `create_release` is REST-only for the same reason.
  {
    setup: { method: "POST", path: "/repos/acme/api/releases" },
    arguments: { tag_name: "v0.0.1-parity", name: "Parity release" },
  },
  { tool: "list_tags", arguments: { ...repo } },
  { tool: "list_releases", arguments: { ...repo } },
  { tool: "get_latest_release", arguments: { ...repo } },
  // M5 hot gaps (F-735)
  { tool: "get_release_by_tag", arguments: { ...repo, tag: "v0.0.1-parity" } },
  { tool: "get_tag", arguments: { ...repo, tag: "v0.0.1-parity" } },
  { tool: "search_commits", arguments: { query: "parity" } },
];

function liveGitHubProbes(): unknown[] {
  const sandboxRepo = process.env.GITHUB_PARITY_REPO;
  if (!sandboxRepo) {
    return [{ real_github: "skipped", reason: "set GITHUB_PARITY_REPO=owner/repo to compare read-only live shapes with gh api" }];
  }
  const endpoints = [
    `repos/${sandboxRepo}`,
    `repos/${sandboxRepo}/contents/README.md`,
    `repos/${sandboxRepo}/issues?state=open&per_page=1`,
    `search/repositories?q=repo:${sandboxRepo}`,
  ];
  return endpoints.map((endpoint) => {
    const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
    return {
      real_github_endpoint: endpoint,
      status: result.status === 0 ? 200 : "gh-error",
      stderr: result.status === 0 ? undefined : result.stderr.trim().slice(0, 400),
    };
  });
}

await runParityCli({
  app: createGitHubCloneApp(),
  twin: "github",
  inventory: loadFidelityInventory(join(import.meta.dirname, "..", "fidelity.inventory.json")),
  fixtureToolNames: [...githubToolFixture.toolNames],
  steps,
  claims: { team_id: "tm_fidelity", login: "pome-agent" },
  restProbes: [
    { surface: "unsupported-rest", path: "/repos/acme/api/actions/runs", status: 501, expectUnsupportedEnvelope: true },
  ],
  live: async () => liveGitHubProbes(),
});
