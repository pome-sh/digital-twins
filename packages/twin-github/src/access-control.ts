// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub twin access-control catalog, and the wiring that proves it describes
 * THIS twin's tools.
 *
 * The catalog is a cross-repo contract between this package (runtime) and
 * `pome-cloud` (dashboard toggles). Until F-942 it lived in
 * `@pome-sh/shared-types` and this file was a three-function shim over it — so
 * a catalog entry naming a tool that does not exist was a change in one package
 * caught (if at all) by a test in another. The data now sits next to the
 * tool-table fixture that is the only thing able to contradict it, and
 * `assertAccessControlCatalogMatchesTools` reads the names straight off
 * `githubToolFixture` — the same listing the twin serves (F-1325), not a
 * second copy of it.
 *
 * Display labels follow the hosted Twins Manage UI: `{METHOD} {operation}`
 * where `operation` is camelCase (with a few legacy aliases like `addComment`).
 *
 * Endpoints are grouped by functional cluster (Issues, Branches & files, ...),
 * aligned with the FDRS-300 hot-path expansion table -- not
 * reversible/irreversible.
 */
import { z } from "zod";
import { GITHUB_ROUTES } from "./route-inputs.js";
import { githubToolFixture } from "./tools.js";

export const githubAccessControlCategorySchema = z.enum([
  "issues",
  "issue_comments",
  "pull_requests",
  "branches_files",
  "commits_diffs",
  "milestones",
  "status_checks",
  "tags_releases",
  "labels",
  "collaborators",
]);
export type GitHubAccessControlCategory = z.infer<typeof githubAccessControlCategorySchema>;

/** Human-readable section headers for the hosted Manage UI. */
export const GITHUB_ACCESS_CONTROL_CATEGORY_LABELS: Record<GitHubAccessControlCategory, string> = {
  issues: "Issues",
  issue_comments: "Issue comments",
  pull_requests: "Pull requests",
  branches_files: "Branches & files",
  commits_diffs: "Commits & diffs",
  milestones: "Milestones",
  status_checks: "Status & checks",
  tags_releases: "Tags & releases",
  labels: "Labels",
  collaborators: "Collaborators & identity",
};

/** Stable render order for dashboard sections. */
export const GITHUB_ACCESS_CONTROL_CATEGORY_ORDER: GitHubAccessControlCategory[] = [
  "issues",
  "issue_comments",
  "pull_requests",
  "branches_files",
  "commits_diffs",
  "milestones",
  "status_checks",
  "tags_releases",
  "labels",
  "collaborators",
];

export const githubAccessControlEndpointSchema = z.object({
  /** MCP tool name (snake_case). Stable id for policy storage. */
  tool: z.string().min(1),
  /** Dashboard label operation segment, e.g. `listIssues`. */
  operation: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  category: githubAccessControlCategorySchema,
  /** Default allow/deny when a session has no explicit override. */
  default_allowed: z.boolean(),
  /** FDRS-300 v2 hot-path; false for the original 25-endpoint surface. */
  v2: z.boolean().default(false),
});
export type GitHubAccessControlEndpoint = z.infer<typeof githubAccessControlEndpointSchema>;

export const githubAccessControlCategoryGroupSchema = z.object({
  category: githubAccessControlCategorySchema,
  label: z.string().min(1),
  endpoints: z.array(githubAccessControlEndpointSchema),
});
export type GitHubAccessControlCategoryGroup = z.infer<typeof githubAccessControlCategoryGroupSchema>;

export const githubAccessControlCatalogSchema = z.object({
  version: z.literal(2),
  twin: z.literal("github"),
  endpoints: z.array(githubAccessControlEndpointSchema).min(1),
  categories: z.array(githubAccessControlCategoryGroupSchema).min(1),
});
export type GitHubAccessControlCatalog = z.infer<typeof githubAccessControlCatalogSchema>;

function entry(
  tool: string,
  operation: string,
  method: GitHubAccessControlEndpoint["method"],
  category: GitHubAccessControlCategory,
  defaultAllowed: boolean,
  v2 = false
): GitHubAccessControlEndpoint {
  return { tool, operation, method, category, default_allowed: defaultAllowed, v2 };
}

// F-1376 — the consolidated MCP tools GitHub declares are policy keys in their
// own right, and they are listed FIRST in each category so a reader meets them
// before the single-purpose names they cover.
//
// They have to be here. `issue_write` reaches the same domain call
// `update_issue` does, so a catalog that gated only `update_issue` would let an
// agent walk around a builder's denial by spelling the call the way GitHub
// spells it. Each one inherits the most restrictive default of the operations it
// subsumes.
const ENDPOINTS: GitHubAccessControlEndpoint[] = [
  // Issues
  entry("issue_read", "issueRead", "GET", "issues", true),
  entry("issue_write", "issueWrite", "POST", "issues", true),
  entry("list_issues", "listIssues", "GET", "issues", true),
  entry("get_issue", "getIssue", "GET", "issues", true),
  entry("create_issue", "createIssue", "POST", "issues", true),
  entry("update_issue", "updateIssue", "PATCH", "issues", true),
  entry("add_assignees", "addAssignees", "POST", "issues", false),

  // Issue comments
  entry("add_issue_comment", "addComment", "POST", "issue_comments", true),
  entry("update_issue_comment", "updateIssueComment", "PATCH", "issue_comments", true, true),
  entry("delete_issue_comment", "deleteIssueComment", "DELETE", "issue_comments", false, true),

  // Pull requests
  entry("pull_request_read", "pullRequestRead", "GET", "pull_requests", true),
  entry("pull_request_review_write", "pullRequestReviewWrite", "POST", "pull_requests", false),
  entry("list_pull_requests", "listPullRequests", "GET", "pull_requests", true),
  entry("get_pull_request", "getPullRequest", "GET", "pull_requests", true),
  entry("create_pull_request", "createPullRequest", "POST", "pull_requests", true),
  entry("update_pull_request", "updatePullRequest", "PATCH", "pull_requests", true, true),
  entry("merge_pull_request", "mergePullRequest", "POST", "pull_requests", false),
  entry("create_pull_request_review", "createReview", "POST", "pull_requests", false),
  entry("get_pull_request_reviews", "listPullRequestReviews", "GET", "pull_requests", true),
  entry("get_pull_request_comments", "listPullRequestComments", "GET", "pull_requests", true),
  entry("get_pull_request_files", "listPullRequestFiles", "GET", "pull_requests", true),
  entry("get_pull_request_status", "getPullRequestStatus", "GET", "pull_requests", true),
  entry("update_pull_request_branch", "updatePullRequestBranch", "POST", "pull_requests", false),
  entry("get_pull_request_diff", "getPullRequestDiff", "GET", "pull_requests", true, true),
  entry("get_pull_request_commits", "listPullRequestCommits", "GET", "pull_requests", true, true),
  entry("create_pull_request_review_comment", "createPullRequestReviewComment", "POST", "pull_requests", true, true),
  entry("add_reply_to_pull_request_comment", "addReplyToPullRequestComment", "POST", "pull_requests", true, true),

  // Branches & files
  entry("create_branch", "createBranch", "POST", "branches_files", true),
  entry("list_branches", "listBranches", "GET", "branches_files", true, true),
  entry("get_branch", "getBranch", "GET", "branches_files", true, true),
  entry("delete_branch", "deleteBranch", "DELETE", "branches_files", false, true),
  entry("get_file_contents", "getContent", "GET", "branches_files", true),
  entry("create_or_update_file", "createOrUpdateFile", "PUT", "branches_files", true),
  entry("delete_file", "deleteFile", "DELETE", "branches_files", false, true),
  entry("push_files", "pushFiles", "POST", "branches_files", false),

  // Commits & diffs
  entry("list_commits", "listCommits", "GET", "commits_diffs", true),
  entry("get_commit", "getCommit", "GET", "commits_diffs", true, true),
  entry("compare_commits", "compareCommits", "GET", "commits_diffs", true, true),

  // Milestones
  entry("list_milestones", "listMilestones", "GET", "milestones", true, true),
  entry("create_milestone", "createMilestone", "POST", "milestones", true, true),
  entry("update_milestone", "updateMilestone", "PATCH", "milestones", true, true),
  entry("delete_milestone", "deleteMilestone", "DELETE", "milestones", false, true),

  // Status & checks
  entry("create_commit_status", "createCommitStatus", "POST", "status_checks", true, true),
  entry("get_combined_status_for_ref", "getCombinedStatusForRef", "GET", "status_checks", true, true),
  entry("create_check_run", "createCheckRun", "POST", "status_checks", true, true),
  entry("list_check_runs_for_ref", "listCheckRunsForRef", "GET", "status_checks", true, true),

  // Tags & releases
  entry("list_tags", "listTags", "GET", "tags_releases", true, true),
  entry("list_releases", "listReleases", "GET", "tags_releases", true, true),
  entry("get_latest_release", "getLatestRelease", "GET", "tags_releases", true, true),
  entry("create_release", "createRelease", "POST", "tags_releases", false, true),

  // Labels
  entry("create_label", "createRepositoryLabel", "POST", "labels", false),
  entry("add_issue_labels", "addIssueLabels", "POST", "labels", false),
  entry("remove_issue_label", "deleteIssueLabel", "DELETE", "labels", false),

  // Collaborators & identity
  entry("list_repository_collaborators", "listRepositoryCollaborators", "GET", "collaborators", true),
  entry("list_collaborators", "listCollaborators", "GET", "collaborators", true),
  entry("get_me", "getMe", "GET", "collaborators", true, true),
  entry("add_collaborator", "addCollaborator", "PUT", "collaborators", false, true),
];

export function groupGitHubAccessControlByCategory(
  endpoints: GitHubAccessControlEndpoint[] = ENDPOINTS
): GitHubAccessControlCategoryGroup[] {
  const byCategory = new Map<GitHubAccessControlCategory, GitHubAccessControlEndpoint[]>();
  for (const category of GITHUB_ACCESS_CONTROL_CATEGORY_ORDER) {
    byCategory.set(category, []);
  }
  for (const endpoint of endpoints) {
    byCategory.get(endpoint.category)!.push(endpoint);
  }
  return GITHUB_ACCESS_CONTROL_CATEGORY_ORDER
    .map((category) => ({
      category,
      label: GITHUB_ACCESS_CONTROL_CATEGORY_LABELS[category],
      endpoints: byCategory.get(category)!,
    }))
    .filter((group) => group.endpoints.length > 0);
}

/** Canonical 52-endpoint sandbox catalog (25 v1 + 27 v2). */
export const GITHUB_ACCESS_CONTROL_CATALOG: GitHubAccessControlCatalog = {
  version: 2,
  twin: "github",
  endpoints: ENDPOINTS,
  categories: groupGitHubAccessControlByCategory(ENDPOINTS),
};

export function formatGitHubAccessControlLabel(endpoint: GitHubAccessControlEndpoint): string {
  return `${endpoint.method} ${endpoint.operation}`;
}

export function summarizeGitHubAccessControlCatalog(
  catalog: GitHubAccessControlCatalog = GITHUB_ACCESS_CONTROL_CATALOG,
  allowedOverrides?: ReadonlySet<string>
) {
  let allowed = 0;
  let denied = 0;
  for (const endpoint of catalog.endpoints) {
    const isAllowed = allowedOverrides?.has(endpoint.tool) ?? endpoint.default_allowed;
    if (isAllowed) allowed += 1;
    else denied += 1;
  }
  return { total: catalog.endpoints.length, allowed, denied };
}

export function githubAccessControlToolNames(
  catalog: GitHubAccessControlCatalog = GITHUB_ACCESS_CONTROL_CATALOG
): string[] {
  return catalog.endpoints.map((endpoint) => endpoint.tool);
}

// ---------------------------------------------------------------- tool wiring

/**
 * Every catalog entry names a surface this twin actually has.
 *
 * ── WHY THIS IS NO LONGER "IS IT AN MCP TOOL" ───────────────────────────────
 *
 * It used to be, and that was right for as long as this twin's MCP tool table
 * and its REST route table named the same operations. F-1376 ended that: GitHub
 * declares no MCP tool for milestones, commit statuses, check runs or
 * issue-comment editing, so those thirty-four tools stopped being served — but
 * every one of them is still reachable over the REST door, which is exactly how
 * an examinee could have reached them at GitHub in the first place.
 *
 * A catalog keyed only to the MCP table would have had to drop those entries,
 * and dropping them is not a no-op: `tool` is the POLICY KEY pome-cloud stores a
 * builder's allow/deny against, so deleting an entry silently un-gates a live
 * REST operation in the dashboard. The check that matters is "does this name
 * point at something this twin serves", and after F-1376 that question has two
 * answers, so it reads both tables.
 *
 * Both halves are derived, never listed here: `githubToolFixture.toolNames` is
 * the served MCP listing (F-1325) and `GITHUB_ROUTES`' keys are the declared
 * REST surface (F-1179). A typo in a catalog entry still fails.
 */
export function assertAccessControlCatalogMatchesTools() {
  const served = new Set<string>([...githubToolFixture.toolNames, ...Object.keys(GITHUB_ROUTES)]);
  const missing = GITHUB_ACCESS_CONTROL_CATALOG.endpoints
    .filter((endpoint) => !served.has(endpoint.tool) && !served.has(endpoint.operation))
    .map((endpoint) => `${endpoint.tool} (${endpoint.operation})`);
  if (missing.length > 0) {
    throw new Error(
      `access-control catalog references surfaces this twin does not serve over MCP or REST: ${missing.join(", ")}`
    );
  }
}

export function githubAccessControlPayload() {
  assertAccessControlCatalogMatchesTools();
  return {
    ...GITHUB_ACCESS_CONTROL_CATALOG,
    summary: summarizeGitHubAccessControlCatalog(),
  };
}
