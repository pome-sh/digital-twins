// file-size: one declaration per REST surface, 66 of them, and `GITHUB_ROUTE_INPUTS` is the complete set the artifact emitter publishes — splitting the list across files would mean this twin's input surface no longer has a single place to read, which is the second source of truth these declarations exist to remove.
// SPDX-License-Identifier: Apache-2.0
//
// Every REST input the GitHub twin accepts, declared in the one place
// that validates it.
//
// Each entry below is BOTH the machine-readable input surface pome-cloud's
// declared-fidelity lane reads and the parser `src/routes.ts` runs: the route is
// registered from `declaration.method` / `declaration.path`, and the handler's
// only view of the request is `declaration.parse()`'s output. There is no second
// list to drift from — see `packages/sdk/src/route-inputs.ts` for why that
// matters more than a written-down inventory would.
//
// What is declared here is what THIS TWIN accepts, not what GitHub documents.
// Where the two differ, the divergence is pome-cloud's to report; silently
// widening a schema to match the vendor would erase the finding.
//
// zod and the sdk's `route-inputs` leaf are the only imports on purpose: the
// artifact emitter and pome-cloud's bun-hosted fidelity-watch load this module
// with no engine behind it (`scripts/check-twin-leaf-portability.mjs`). Never
// reach for the `@pome-sh/sdk` barrel — it drags `node:sqlite`.

import { z } from "zod";
import {
  integerInput,
  routeInputDeclarer,
  type RouteInputDeclaration,
} from "@pome-sh/sdk/route-inputs";

/**
 * GitHub accepts a query parameter it does not know and discards it,
 * so this twin does too.
 *
 * Measured 2026-08-09 against `api.github.com`: ten surfaces across every shape
 * this twin serves — `/rate_limit`, `/users/octocat`, `/orgs/github`,
 * `/users/:username/repos`, `/repos/:owner/:repo` with its `/issues`,
 * `/commits`, `/branches` and `/contents/*` children, and
 * `/search/repositories` — each answered 200 with `?pome_undeclared_probe=x`
 * appended, and the two bodies hashed the same on every one. `POST /markdown`
 * did the same for an unknown top-level BODY key.
 * `docs/undeclared-route-inputs.md` carries the transcript.
 *
 * This twin used to refuse, which is the divergence that matters most:
 * an agent written against real GitHub sends a parameter this twin has not got
 * around to declaring, real GitHub serves it, the twin 4xx'd, and the exam
 * recorded a failure the agent did not commit. The declaration below does not
 * widen by one field to buy that back — what this twin is short of GitHub is
 * still pome-cloud's finding to report, and `route-inputs.json` is unchanged.
 */
const declareInputs = routeInputDeclarer("ignore");

// ─── Shared input vocabulary ────────────────────────────────────────────────

/** `:owner` / `:repo` — the pair almost every surface is scoped by. */
const repoParams = { owner: z.string().min(1), repo: z.string().min(1) };

/** GitHub spells issue, PR and milestone numbers `:number` in the URL. */
const numberParam = integerInput({ min: 1 });

/** `?page=` / `?per_page=`, the twin's only pagination inputs. */
const pageQuery = {
  page: integerInput({ min: 1 }).optional(),
  per_page: integerInput({ min: 1 }).optional(),
};

/**
 * `?state=`. Declared strictly: the retired `stateQuery()` helper mapped an
 * unrecognised value to `undefined`, so `?state=merged` silently listed
 * everything. An input the vendor rejects that we ignore is the exact failure
 * these declarations exist to make impossible, so this is a 422 now.
 */
const stateFilter = z.enum(["open", "closed", "all"]).optional();

/** Issue/PR/milestone open-closed writes (no `all` — you cannot set it). */
const stateWrite = z.enum(["open", "closed"]).optional();

/** `POST /user/repos` and `POST /orgs/:owner/repos` share this body. */
const repositoryBody = {
  name: z.string().min(1),
  description: z.string().optional(),
  private: z.boolean().optional(),
};

const commentBody = { body: z.string().min(1) };

// ─── Declarations ───────────────────────────────────────────────────────────
//
// Order matches registration order in `src/routes.ts`, which is hono's
// first-match order; reordering these reorders the router.

export const GITHUB_ROUTES = {
  // ----- search -----
  //
  // GH-DECL-IN-001 / GH-DECL-IN-002 — all five take `q` and nothing but
  // `q`. GitHub's search API has ONE scoping input and encodes every filter as a
  // qualifier inside it (`repo:octocat/hello-world`, `state:open`); its OpenAPI
  // declares `q, sort, order, per_page, page`. `/search/code`,
  // `/search/commits` and `/search/issues` used to declare `owner` / `repo`
  // (and `state`) alongside and scope by them, so the same request was scoped
  // here and unscoped on GitHub.
  //
  // They are undeclared rather than refused, per github's measured `ignore`
  // ruling — a request still sending them gets the answer it would have got
  // without them, which is what real GitHub does. The scoping moved into `q`:
  // `domain/search.ts` parses `repo:` / `user:` / `org:` / `state:` out of it.
  // Both halves had to land together — deleting the parameters alone would have
  // left `q=idempotency repo:acme/api` still answering zero, which is the
  // mirror defect and the worse one.
  searchRepositories: declareInputs({
    method: "GET",
    path: "/search/repositories",
    query: { q: z.string().optional(), ...pageQuery },
  }),
  searchCode: declareInputs({
    method: "GET",
    path: "/search/code",
    query: { q: z.string().optional(), ...pageQuery },
  }),
  searchIssues: declareInputs({
    method: "GET",
    path: "/search/issues",
    query: { q: z.string().optional(), ...pageQuery },
  }),
  searchUsers: declareInputs({
    method: "GET",
    path: "/search/users",
    query: { q: z.string().optional(), ...pageQuery },
  }),
  searchCommits: declareInputs({
    method: "GET",
    path: "/search/commits",
    query: { q: z.string().optional(), ...pageQuery },
  }),

  // ----- repositories -----
  getRepository: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo",
    pathParams: { ...repoParams },
  }),
  createUserRepository: declareInputs({
    method: "POST",
    path: "/user/repos",
    bodyEncoding: "json",
    // GH-DECL-IN — no `owner`. This surface creates a repository
    // for the AUTHENTICATED USER, which is its whole meaning;
    // `repos/create-for-authenticated-user` declares 23 body properties and
    // `owner` is not one. `routes.ts` passed the body straight to
    // `domain.createRepository`, so the one surface defined not to take an
    // owner could be made to create a repository under an arbitrary one.
    // Undeclared now, so `parse()` never hands it to the handler, and github's
    // measured disposition (`ignore`) discards it rather than 422-ing a request
    // real GitHub accepts and ignores.
    body: { ...repositoryBody },
  }),
  // `owner` stays declared on the ORG surface, and the contrast is the whole
  // argument: there the handler overwrites it with the path value, so the body
  // copy is read and discarded and nothing observable differs. That one is
  // registered `accepted` (GH-DECL-IN-004); the `/user/repos` one above was
  // registered `open-defect` because there the body copy reached the domain.
  createOrgRepository: declareInputs({
    method: "POST",
    path: "/orgs/:owner/repos",
    pathParams: { owner: repoParams.owner },
    bodyEncoding: "json",
    body: { ...repositoryBody, owner: z.string().min(1).optional() },
  }),
  forkRepository: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/forks",
    pathParams: { ...repoParams },
    bodyEncoding: "json-optional",
    body: { organization: z.string().optional() },
  }),

  // ----- contents & commits -----
  getRepositoryRootContents: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/contents",
    pathParams: { ...repoParams },
    query: { ref: z.string().optional() },
  }),
  getFileContents: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/contents/*",
    pathParams: { ...repoParams, path: z.string().min(1) },
    query: { ref: z.string().optional() },
  }),
  createOrUpdateFile: declareInputs({
    method: "PUT",
    path: "/repos/:owner/:repo/contents/*",
    pathParams: { ...repoParams, path: z.string().min(1) },
    bodyEncoding: "json",
    body: {
      message: z.string().min(1),
      content: z.string(),
      branch: z.string().optional(),
      sha: z.string().optional(),
      // GH-DECL-IN — no `encoding`. GitHub declares `content` as
      // "the new file content, using Base64 encoding" and takes no `encoding`
      // parameter: base64 is the only encoding this surface has. Undeclared
      // now, so github's measured disposition (`ignore`) discards it.
      //
      // The behavioural half is closed too: `routes.ts` base64-decodes this
      // field via `rest-content.ts`, and invalid base64 gets GitHub's own 422.
      // ⚠️ ON THIS DOOR ONLY — the MCP write tools take plain text, because
      // GitHub's MCP server does. Divergence 24 is retired; see FIDELITY.md
      // "The two doors take `content` differently" before touching either.
    },
  }),
  listCommits: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/commits",
    pathParams: { ...repoParams },
    query: { sha: z.string().optional(), ...pageQuery },
  }),
  createRef: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/git/refs",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: { ref: z.string().min(1), sha: z.string().optional() },
  }),

  // ----- issues -----
  listIssues: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/issues",
    pathParams: { ...repoParams },
    query: {
      state: stateFilter,
      labels: z.string().optional(),
      assignee: z.string().optional(),
      ...pageQuery,
    },
  }),
  createIssue: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/issues",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: {
      title: z.string().min(1),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
    },
  }),
  getIssue: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/issues/:number",
    pathParams: { ...repoParams, number: numberParam },
  }),
  updateIssue: declareInputs({
    method: "PATCH",
    path: "/repos/:owner/:repo/issues/:number",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: {
      title: z.string().optional(),
      body: z.string().optional(),
      state: stateWrite,
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
    },
  }),
  listIssueComments: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/issues/:number/comments",
    pathParams: { ...repoParams, number: numberParam },
    query: { ...pageQuery },
  }),
  addIssueComment: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/issues/:number/comments",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: { ...commentBody },
  }),
  listRepositoryLabels: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/labels",
    pathParams: { ...repoParams },
  }),
  createRepositoryLabel: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/labels",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: {
      name: z.string().min(1),
      color: z.string().default("ededed"),
      description: z.string().default(""),
    },
  }),
  listIssueLabels: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/issues/:number/labels",
    pathParams: { ...repoParams, number: numberParam },
  }),
  addIssueLabels: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/issues/:number/labels",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: { labels: z.array(z.string().min(1)).min(1) },
  }),
  deleteIssueLabel: declareInputs({
    method: "DELETE",
    path: "/repos/:owner/:repo/issues/:number/labels/:name",
    pathParams: { ...repoParams, number: numberParam, name: z.string().min(1) },
  }),
  listCollaborators: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/collaborators",
    pathParams: { ...repoParams },
  }),
  checkCollaborator: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/collaborators/:username",
    pathParams: { ...repoParams, username: z.string().min(1) },
  }),
  addAssignees: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/issues/:number/assignees",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: { assignees: z.array(z.string().min(1)).min(1) },
  }),

  // ----- pull requests -----
  listPullRequests: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls",
    pathParams: { ...repoParams },
    query: { state: stateFilter, ...pageQuery },
  }),
  createPullRequest: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/pulls",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: {
      title: z.string().min(1),
      body: z.string().optional(),
      head: z.string().min(1),
      base: z.string().optional(),
    },
  }),
  getPullRequest: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number",
    pathParams: { ...repoParams, number: numberParam },
  }),
  listPullRequestFiles: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number/files",
    pathParams: { ...repoParams, number: numberParam },
    query: { ...pageQuery },
  }),
  listPullRequestReviews: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number/reviews",
    pathParams: { ...repoParams, number: numberParam },
    query: { ...pageQuery },
  }),
  createPullRequestReview: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/pulls/:number/reviews",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: {
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string().optional(),
    },
  }),
  listPullRequestComments: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number/comments",
    pathParams: { ...repoParams, number: numberParam },
    query: { ...pageQuery },
  }),
  getPullRequestStatus: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number/status",
    pathParams: { ...repoParams, number: numberParam },
  }),
  mergePullRequest: declareInputs({
    method: "PUT",
    path: "/repos/:owner/:repo/pulls/:number/merge",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json-optional",
    body: { commit_title: z.string().optional(), commit_message: z.string().optional() },
  }),
  updatePullRequestBranch: declareInputs({
    method: "PUT",
    path: "/repos/:owner/:repo/pulls/:number/update-branch",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json-optional",
    body: { expected_head_sha: z.string().optional() },
  }),

  // ----- v2 cluster A — branches & files -----
  listBranches: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/branches",
    pathParams: { ...repoParams },
    query: { ...pageQuery },
  }),
  // `branch` is the wildcard: a branch name may contain `/`, so the tail is the
  // whole remainder of the path. The mechanism reads and URL-decodes it.
  getBranch: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/branches/*",
    pathParams: { ...repoParams, branch: z.string().min(1) },
  }),
  deleteBranch: declareInputs({
    method: "DELETE",
    path: "/repos/:owner/:repo/git/refs/heads/*",
    pathParams: { ...repoParams, branch: z.string().min(1) },
  }),
  deleteFile: declareInputs({
    method: "DELETE",
    path: "/repos/:owner/:repo/contents/*",
    pathParams: { ...repoParams, path: z.string().min(1) },
    bodyEncoding: "json",
    body: {
      message: z.string().min(1),
      sha: z.string().min(1),
      branch: z.string().optional(),
    },
  }),

  // ----- v2 cluster B — commits & diffs -----
  getCommit: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/commits/:ref",
    pathParams: { ...repoParams, ref: z.string().min(1) },
  }),
  // `:basehead{.+}` is a NAMED param with a regex tail, not a wildcard; the
  // handler is what splits `base...head` out of it.
  compareCommits: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/compare/:basehead{.+}",
    pathParams: { ...repoParams, basehead: z.string().min(1) },
  }),
  getPullRequestDiff: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number/diff",
    pathParams: { ...repoParams, number: numberParam },
  }),

  // ----- v2 cluster C — pull requests deeper -----
  updatePullRequest: declareInputs({
    method: "PATCH",
    path: "/repos/:owner/:repo/pulls/:number",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: {
      title: z.string().optional(),
      body: z.string().optional(),
      state: stateWrite,
      base: z.string().optional(),
    },
  }),
  listPullRequestCommits: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/pulls/:number/commits",
    pathParams: { ...repoParams, number: numberParam },
    query: { ...pageQuery },
  }),
  createPullRequestReviewComment: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/pulls/:number/comments",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: {
      body: z.string().min(1),
      path: z.string().min(1),
      line: integerInput({ min: 1 }),
      side: z.enum(["LEFT", "RIGHT"]).optional(),
      commit_id: z.string().optional(),
    },
  }),
  replyToPullRequestReviewComment: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/pulls/:number/comments/:comment_id/replies",
    pathParams: { ...repoParams, number: numberParam, comment_id: numberParam },
    bodyEncoding: "json",
    body: { ...commentBody },
  }),

  // ----- v2 cluster D — issue comments deeper -----
  updateIssueComment: declareInputs({
    method: "PATCH",
    path: "/repos/:owner/:repo/issues/comments/:comment_id",
    pathParams: { ...repoParams, comment_id: numberParam },
    bodyEncoding: "json",
    body: { ...commentBody },
  }),
  deleteIssueComment: declareInputs({
    method: "DELETE",
    path: "/repos/:owner/:repo/issues/comments/:comment_id",
    pathParams: { ...repoParams, comment_id: numberParam },
  }),

  // ----- v2 cluster E — milestones -----
  listMilestones: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/milestones",
    pathParams: { ...repoParams },
    query: { state: stateFilter, ...pageQuery },
  }),
  createMilestone: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/milestones",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: {
      title: z.string().min(1),
      description: z.string().optional(),
      due_on: z.string().optional(),
      state: stateWrite,
    },
  }),
  updateMilestone: declareInputs({
    method: "PATCH",
    path: "/repos/:owner/:repo/milestones/:number",
    pathParams: { ...repoParams, number: numberParam },
    bodyEncoding: "json",
    body: {
      title: z.string().optional(),
      description: z.string().optional(),
      due_on: z.string().optional(),
      state: stateWrite,
    },
  }),
  deleteMilestone: declareInputs({
    method: "DELETE",
    path: "/repos/:owner/:repo/milestones/:number",
    pathParams: { ...repoParams, number: numberParam },
  }),

  // ----- v2 cluster F — commit status + checks -----
  createCommitStatus: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/statuses/:sha",
    pathParams: { ...repoParams, sha: z.string().min(1) },
    bodyEncoding: "json",
    body: {
      state: z.enum(["error", "failure", "pending", "success"]),
      context: z.string().optional(),
      description: z.string().optional(),
      target_url: z.string().optional(),
    },
  }),
  getCombinedStatusForRef: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/commits/:ref/status",
    pathParams: { ...repoParams, ref: z.string().min(1) },
  }),
  createCheckRun: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/check-runs",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: {
      name: z.string().min(1),
      head_sha: z.string().min(1),
      status: z.enum(["queued", "in_progress", "completed"]).optional(),
      conclusion: z
        .enum([
          "success",
          "failure",
          "neutral",
          "cancelled",
          "timed_out",
          "action_required",
          "skipped",
          "stale",
        ])
        .optional(),
      details_url: z.string().optional(),
      external_id: z.string().optional(),
      output: z.object({ title: z.string().optional(), summary: z.string().optional() }).optional(),
      started_at: z.string().optional(),
      completed_at: z.string().optional(),
    },
  }),
  listCheckRunsForRef: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/commits/:ref/check-runs",
    pathParams: { ...repoParams, ref: z.string().min(1) },
    query: { ...pageQuery },
  }),

  // ----- v2 cluster G — tags & releases -----
  listTags: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/tags",
    pathParams: { ...repoParams },
    query: { ...pageQuery },
  }),
  listReleases: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/releases",
    pathParams: { ...repoParams },
    query: { ...pageQuery },
  }),
  getLatestRelease: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/releases/latest",
    pathParams: { ...repoParams },
  }),
  getReleaseByTag: declareInputs({
    method: "GET",
    path: "/repos/:owner/:repo/releases/tags/*",
    pathParams: { ...repoParams, tag: z.string().min(1) },
  }),
  createRelease: declareInputs({
    method: "POST",
    path: "/repos/:owner/:repo/releases",
    pathParams: { ...repoParams },
    bodyEncoding: "json",
    body: {
      tag_name: z.string().min(1),
      target_commitish: z.string().optional(),
      name: z.string().optional(),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      prerelease: z.boolean().optional(),
    },
  }),

  // ----- v2 cluster H — identity & collaborators -----
  // The authenticated login comes from the session claim, not from a request
  // input, so this surface declares nothing.
  getAuthenticatedUser: declareInputs({ method: "GET", path: "/user" }),
  addCollaborator: declareInputs({
    method: "PUT",
    path: "/repos/:owner/:repo/collaborators/:username",
    pathParams: { ...repoParams, username: z.string().min(1) },
    bodyEncoding: "json-optional",
    body: {
      permission: z.enum(["pull", "push", "admin", "maintain", "triage"]).optional(),
    },
  }),
} as const;

/** Every REST route this twin serves. Read by the artifact emitter and the 1:1 test. */
export const GITHUB_ROUTE_INPUTS: readonly RouteInputDeclaration[] = Object.values(GITHUB_ROUTES);
