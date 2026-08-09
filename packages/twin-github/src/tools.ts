// SPDX-License-Identifier: Apache-2.0
// `@pome-sh/sdk/mcp-tool-fixture` rather than the `@pome-sh/sdk` root: the root
// barrel re-exports `openTwinDatabase`, so importing it EXECUTES `db.ts`'s
// `import { DatabaseSync } from "node:sqlite"`. pome-cloud's fidelity-watch
// loads twin tool tables under bun, which implements no `node:sqlite`, and this
// file's own dependencies are a fixture loader, zod and types. The loader module
// has no imports at all.
import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";
import { z } from "zod";
import type { StateDelta } from "@pome-sh/wire";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import type { GitHubDomain } from "./domain/index.js";
import { TwinError, validationFailed } from "./errors.js";

/**
 * The tool table GitHub serves. Every name, description and input schema on
 * the wire comes from this fixture; the array below declares only how each
 * tool's arguments are validated (F-1325).
 *
 * Its substrate is `twin-code-transcription` — this listing was read off this
 * twin, not off GitHub. F-1326's upstream golden records 44 tools for the
 * `default` toolset the examples point at, against the 65 here. That gap is
 * real, and closing it is not F-1325's to do: reporting it is F-1327's.
 */
export const githubToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

const pageShape = {
  page: z.coerce.number().int().positive().optional(),
  per_page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().optional()
};

const ownerRepo = {
  owner: z.string().min(1),
  repo: z.string().min(1)
};

const prNumber = {
  pull_number: z.coerce.number().int().positive().optional(),
  pullNumber: z.coerce.number().int().positive().optional()
};

export type ToolExecutionOptions = { actor?: string };

const issueNumber = {
  issue_number: z.coerce.number().int().positive(),
  issueNumber: z.coerce.number().int().positive().optional()
};

function normalizeIssueNumber<T extends { issue_number?: number; issueNumber?: number }>(input: T) {
  return { ...input, issue_number: input.issue_number ?? input.issueNumber! };
}

function normalizePullNumber<T extends { pull_number?: number; pullNumber?: number }>(input: T) {
  return { ...input, pull_number: input.pull_number ?? input.pullNumber! };
}

function normalizeCommentId<T extends { comment_id?: number; commentId?: number }>(input: T) {
  return { ...input, comment_id: input.comment_id ?? input.commentId! };
}

/**
 * How each tool's arguments are validated, indexed by the name the fixture
 * declares. `githubToolInputSchema` is the projection that produced every
 * `inputSchema` in the fixture, and the contract suite runs it over each
 * schema here and demands those bytes back — so the validator and the
 * declaration cannot part company.
 */
export const toolArgumentSchemas = [
  {
    name: "search_repositories",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), ...pageShape })
  },
  {
    name: "create_repository",
    schema: z.object({ name: z.string().min(1), owner: z.string().min(1).optional(), description: z.string().optional(), private: z.boolean().optional() })
  },
  {
    name: "fork_repository",
    schema: z.object({ ...ownerRepo, organization: z.string().min(1).optional() })
  },
  {
    name: "search_code",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), owner: z.string().optional(), repo: z.string().optional(), ...pageShape })
  },
  {
    name: "search_users",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), ...pageShape })
  },
  {
    name: "get_file_contents",
    schema: z.object({ ...ownerRepo, path: z.string().optional(), ref: z.string().optional() })
  },
  {
    name: "list_commits",
    schema: z.object({ ...ownerRepo, sha: z.string().optional(), ...pageShape })
  },
  {
    name: "create_or_update_file",
    schema: z.object({ ...ownerRepo, path: z.string().min(1), message: z.string().min(1), content: z.string(), branch: z.string().optional(), sha: z.string().optional(), encoding: z.enum(["utf-8", "base64"]).optional() })
  },
  {
    name: "create_branch",
    schema: z.object({ ...ownerRepo, branch: z.string().min(1), from_branch: z.string().optional(), sha: z.string().optional() })
  },
  {
    name: "push_files",
    schema: z.object({ ...ownerRepo, branch: z.string().optional(), message: z.string().min(1), files: z.array(z.object({ path: z.string().min(1), content: z.string(), encoding: z.enum(["utf-8", "base64"]).optional() })).min(1) })
  },
  // GitHub's consolidated issue pair (F-1376). `issue_read` and `issue_write`
  // replace the seven single-purpose tools this twin used to serve — `get_issue`,
  // `update_issue`, `list_issue_comments`, `list_issue_labels`,
  // `add_issue_labels`, `remove_issue_label`, `add_assignees` — none of which
  // GitHub declares any more. The property names and the `method` enums are the
  // vendor's, so a call written against `api.githubcopilot.com/mcp/` lands here
  // unchanged; the methods this twin does not implement answer loudly rather
  // than silently succeeding.
  {
    name: "issue_read",
    schema: z.object({
      method: z.enum(["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"]),
      ...ownerRepo,
      issue_number: z.coerce.number().int().positive(),
      page: z.coerce.number().int().positive().optional(),
      perPage: z.coerce.number().int().positive().optional()
    })
  },
  {
    name: "issue_write",
    schema: z.object({
      method: z.enum(["create", "update"]),
      ...ownerRepo,
      issue_number: z.coerce.number().int().positive().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional()
    }).refine(
      (value) => (value.method === "create" ? typeof value.title === "string" && value.title.length > 0 : value.issue_number !== undefined),
      "method 'create' requires title; method 'update' requires issue_number"
    )
  },
  {
    name: "search_issues",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), state: z.enum(["open", "closed", "all"]).optional(), ...pageShape })
  },
  {
    name: "list_issues",
    schema: z.object({ ...ownerRepo, state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional(), assignee: z.string().optional(), ...pageShape })
  },
  {
    name: "add_issue_comment",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), body: z.string().min(1) }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  // Kept, and registered as a divergence rather than removed (F-1376): GitHub
  // serves this exact name from the `issues` toolset when the client sets
  // `X-MCP-Features: issues_granular`, so an examinee can legitimately call it.
  // The divergence is that this twin serves it unconditionally.
  {
    name: "create_issue",
    schema: z.object({ ...ownerRepo, title: z.string().min(1), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() })
  },
  {
    name: "list_repository_collaborators",
    schema: z.object({
      ...ownerRepo,
      affiliation: z.enum(["outside", "direct", "all"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      perPage: z.coerce.number().int().positive().optional()
    })
  },
  // GitHub's consolidated pull-request reader (F-1376), replacing the seven
  // `get_pull_request*` tools GitHub no longer declares.
  {
    name: "pull_request_read",
    schema: z.object({
      method: z.enum([
        "get",
        "get_diff",
        "get_status",
        "get_files",
        "get_commits",
        "get_review_comments",
        "get_reviews",
        "get_comments",
        "get_check_runs"
      ]),
      ...ownerRepo,
      pullNumber: z.coerce.number().int().positive(),
      page: z.coerce.number().int().positive().optional(),
      perPage: z.coerce.number().int().positive().optional()
    })
  },
  {
    name: "pull_request_review_write",
    schema: z.object({
      method: z.enum(["create", "submit_pending", "delete_pending", "resolve_thread", "unresolve_thread"]),
      ...ownerRepo,
      pullNumber: z.coerce.number().int().positive(),
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
      body: z.string().optional()
    })
  },
  // Kept and registered for the same reason as `create_issue`: GitHub serves
  // this name from the `pull_requests` toolset under
  // `X-MCP-Features: pull_requests_granular`.
  {
    name: "create_pull_request_review",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "list_pull_requests",
    schema: z.object({ ...ownerRepo, state: z.enum(["open", "closed", "all"]).optional(), ...pageShape })
  },
  {
    name: "merge_pull_request",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), commit_title: z.string().optional(), commit_message: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "update_pull_request_branch",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), expected_head_sha: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "create_pull_request",
    schema: z.object({ ...ownerRepo, title: z.string().min(1), body: z.string().optional(), head: z.string().min(1), base: z.string().optional() })
  },
  // ===== v2 hot paths (FDRS-300) ==========================================
  // Cluster A — branches & files
  {
    name: "list_branches",
    schema: z.object({ ...ownerRepo, ...pageShape })
  },
  {
    name: "delete_file",
    schema: z.object({ ...ownerRepo, path: z.string().min(1), message: z.string().min(1), sha: z.string().min(1), branch: z.string().optional() })
  },
  // Cluster B — commits & diffs
  {
    name: "get_commit",
    schema: z.object({ ...ownerRepo, ref: z.string().min(1) })
  },
  // Cluster C — PR deeper
  {
    name: "update_pull_request",
    schema: z.object({ ...ownerRepo, ...prNumber, title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), base: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "add_reply_to_pull_request_comment",
    schema: z.object({ ...ownerRepo, ...prNumber, comment_id: z.coerce.number().int().positive().optional(), commentId: z.coerce.number().int().positive().optional(), body: z.string().min(1) }).refine((value) => (value.pull_number ?? value.pullNumber) && (value.comment_id ?? value.commentId), "pull_number and comment_id are required")
  },
  // Clusters D–F (issue comments deeper, milestones, status + checks) served
  // fourteen tools GitHub's MCP server does not register under any toolset or
  // feature flag. They were GitHub REST operations that were never MCP tools,
  // so an examinee could only ever have reached them the way it still can —
  // over this twin's REST door, which is unchanged (F-1376, group D).
  // Cluster G — tags & releases
  {
    name: "list_tags",
    schema: z.object({ ...ownerRepo, ...pageShape })
  },
  {
    name: "list_releases",
    schema: z.object({ ...ownerRepo, ...pageShape })
  },
  {
    name: "get_latest_release",
    schema: z.object({ ...ownerRepo })
  },
  // Cluster H — identity & collaborators
  {
    name: "get_me",
    schema: z.object({})
  },
  // M5 hot gaps (F-735)
  {
    name: "search_commits",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), owner: z.string().optional(), repo: z.string().optional(), ...pageShape })
  },
  {
    name: "get_release_by_tag",
    schema: z.object({ ...ownerRepo, tag: z.string().min(1) })
  },
  {
    name: "get_tag",
    schema: z.object({ ...ownerRepo, tag: z.string().min(1) })
  }
] as const;

export type ToolName = (typeof toolArgumentSchemas)[number]["name"];

/**
 * The frozen wire projection of a GitHub tool's arguments, `$schema` key and
 * all. Nothing serves it any more — the fixture does — but the contract suite
 * still runs it over every schema above and compares.
 */
export function githubToolInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

const MUTATING_TOOL_NAMES = new Set<string>([
  "create_repository",
  "fork_repository",
  "create_or_update_file",
  "create_branch",
  "push_files",
  "issue_write",
  "add_issue_comment",
  "create_issue",
  "pull_request_review_write",
  "create_pull_request_review",
  "merge_pull_request",
  "update_pull_request_branch",
  "create_pull_request",
  // v2 hot paths (FDRS-300)
  "delete_file",
  "update_pull_request",
  "add_reply_to_pull_request_comment"
]);

export function isMutatingTool(name: string) {
  return MUTATING_TOOL_NAMES.has(name);
}

// F-1125 — the actions a tape check may assert "was never called" about.
//
// The constant MOVED to `./tape-assertable-tools.js` (F-1306) and is re-exported
// here so `routes.ts`, the package root and `test/tool-stamping.test.ts` keep
// reading it from where they always did. It left because `check-params.ts` reads
// it too, and importing it from this module put ~40 zod tool schemas and
// `executeTool`'s whole domain dispatch into the import graph of
// `@pome-sh/twin-github/checks` — a subpath the CLI loads on every invocation
// because `pome checks` needs the vocabulary synchronously. See that file for
// why membership is a promise rather than a label.
export { TAPE_ASSERTABLE_TOOLS } from "./tape-assertable-tools.js";

export function executeTool(
  domain: GitHubDomain,
  name: string,
  input: unknown,
  onDelta?: (delta: StateDelta) => void,
  options: ToolExecutionOptions = {}
) {
  const definition = toolArgumentSchemas.find((tool) => tool.name === name);
  if (!definition) {
    validationFailed("tool", "invalid", name);
  }
  const parsed = definition.schema.parse(input) as any;
  switch (name as ToolName) {
    case "search_repositories":
      return domain.searchRepositories(parsed);
    case "create_repository":
      return domain.createRepository(parsed, onDelta);
    case "fork_repository":
      return domain.forkRepository(parsed, onDelta);
    case "search_code":
      return domain.searchCode(parsed);
    case "search_users":
      return domain.searchUsers(parsed);
    case "get_file_contents":
      return domain.getFileContents(parsed);
    case "list_commits":
      return domain.listCommits(parsed);
    case "create_or_update_file":
      return domain.createOrUpdateFile(parsed, { actor: options.actor }, onDelta);
    case "create_branch":
      return domain.createBranch(parsed, onDelta);
    case "push_files":
      return domain.pushFiles(parsed, { actor: options.actor }, onDelta);
    case "issue_read":
      switch (parsed.method) {
        case "get":
          return domain.getIssue(parsed);
        case "get_comments":
          return domain.listIssueComments(parsed);
        case "get_labels":
          return domain.listIssueLabelsForIssue(parsed);
        default:
          // `get_sub_issues` and `get_parent` are GitHub methods this twin does
          // not model. Loud, not silent: an examinee must not read an empty
          // answer as "this issue has no parent".
          throw new TwinError(`issue_read method '${parsed.method}' is not supported by this GitHub twin clone.`, 501);
      }
    case "issue_write":
      switch (parsed.method) {
        case "create":
          return domain.createIssue(parsed, onDelta);
        default:
          return domain.updateIssue(parsed, onDelta);
      }
    case "search_issues":
      return domain.searchIssues(parsed);
    case "list_issues":
      return domain.listIssues(parsed);
    case "add_issue_comment":
      return domain.addIssueComment(normalizeIssueNumber(parsed), onDelta);
    case "create_issue":
      return domain.createIssue(parsed, onDelta);
    case "list_repository_collaborators":
      return domain.listCollaborators(parsed);
    case "pull_request_read": {
      const pull = { ...parsed, pull_number: parsed.pullNumber };
      switch (parsed.method) {
        case "get":
          return domain.getPullRequest(pull);
        case "get_diff":
          return domain.getPullRequestDiff(pull);
        case "get_status":
          return domain.getPullRequestStatus(pull);
        case "get_files":
          return domain.getPullRequestFiles(pull);
        case "get_commits":
          return domain.getPullRequestCommits(pull);
        case "get_reviews":
          return domain.getPullRequestReviews(pull);
        // GitHub distinguishes issue-level `get_comments` from diff-level
        // `get_review_comments`; this twin stores one comment thread per PR and
        // answers both from it rather than inventing a split it does not model.
        case "get_comments":
        case "get_review_comments":
          return domain.getPullRequestComments(pull);
        case "get_check_runs": {
          const head = (domain.getPullRequest(pull) as { head?: { ref?: string } }).head;
          return domain.listCheckRunsForRef({ ...pull, ref: head?.ref ?? "" });
        }
        default:
          throw new TwinError(
            `pull_request_read method '${parsed.method}' is not supported by this GitHub twin clone.`,
            501
          );
      }
    }
    case "pull_request_review_write":
      if (parsed.method !== "create") {
        throw new TwinError(
          `pull_request_review_write method '${parsed.method}' is not supported by this GitHub twin clone.`,
          501
        );
      }
      // GitHub creates a PENDING review when `event` is omitted; this twin has
      // no pending-review state, so it refuses rather than submitting one the
      // caller did not ask to submit.
      if (parsed.event === undefined) {
        throw new TwinError(
          "pull_request_review_write method 'create' without an `event` opens a pending review, which this GitHub twin clone does not model.",
          501
        );
      }
      return domain.createPullRequestReview({ ...parsed, pull_number: parsed.pullNumber }, onDelta);
    case "create_pull_request_review":
      return domain.createPullRequestReview(normalizePullNumber(parsed), onDelta);
    case "list_pull_requests":
      return domain.listPullRequests(parsed);
    case "merge_pull_request":
      if (!options.actor || !domain.hasRepositoryPermission({ owner: parsed.owner, repo: parsed.repo, username: options.actor, permissions: ["push", "maintain", "admin"] })) {
        throw new TwinError("Must have push access to the repository to merge pull requests.", 403);
      }
      return domain.mergePullRequest(normalizePullNumber(parsed), onDelta);
    case "update_pull_request_branch":
      return domain.updatePullRequestBranch(normalizePullNumber(parsed), onDelta);
    case "create_pull_request":
      return domain.createPullRequest({ ...parsed, actor: parsed.actor ?? options.actor }, onDelta);
    // ===== v2 hot paths (FDRS-300) ========================================
    case "list_branches":
      return domain.listBranchesForRepo(parsed);
    case "delete_file":
      return domain.deleteFile(parsed, { actor: options.actor }, onDelta);
    case "get_commit":
      return domain.getCommitWithFiles(parsed);
    case "update_pull_request":
      return domain.updatePullRequest(normalizePullNumber(parsed), onDelta);
    case "add_reply_to_pull_request_comment":
      return domain.addReplyToPullRequestComment(normalizeCommentId(normalizePullNumber(parsed)), { actor: options.actor }, onDelta);
    case "list_tags":
      return domain.listTags(parsed);
    case "list_releases":
      return domain.listReleases(parsed);
    case "get_latest_release":
      return domain.getLatestRelease(parsed);
    case "get_me":
      return domain.getMe({ actor: options.actor });
    // M5 hot gaps (F-735)
    case "search_commits":
      return domain.searchCommits(parsed);
    case "get_release_by_tag":
      return domain.getReleaseByTag(parsed);
    case "get_tag":
      return domain.getTag(parsed);
  }
}
