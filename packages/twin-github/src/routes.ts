// SPDX-License-Identifier: Apache-2.0
//
// GitHub REST domain routes (F-682, F-1179).
//
// Every route is mounted FROM its own declaration in `./route-inputs.ts` — the
// method and path are written down exactly once — and every handler receives its
// path, query, header and body values from that declaration's `parse()`. No
// handler here touches the request: the imperative query, path-param and
// JSON-body reads this file used to make are gone, and
// `scripts/lint-route-input-declarations.mjs` fails the build if one comes back.
// `c` survives only for `c.get("session")`, which is caller IDENTITY, not a
// route input.
//
// Pure domain shape otherwise: each handler maps declared inputs onto a
// GitHubDomain call and returns the GitHub-shaped result with its frozen status
// code. Everything cross-cutting — auth, recording, redaction, error envelopes,
// the 501 catch-all — is the engine's (`@pome-sh/sdk`), wired through the twin
// manifest in ./twin.ts.

import type { Context, Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import {
  MalformedBodyError,
  UndeclaredInputError,
  mountDeclaredRoute,
  type DeclaredRouteInputs,
  type RouteInputDeclaration,
  type RouteInputSpec,
} from "@pome-sh/sdk/route-inputs";
import type { StateDelta } from "@pome-sh/wire";
import type { GitHubDomain } from "./domain/index.js";
import { TwinError, validationFailed } from "./errors.js";
import { GITHUB_ROUTES } from "./route-inputs.js";
import { TAPE_ASSERTABLE_TOOLS } from "./tools.js";

type HandleResult = { status: number; body: unknown; mutation?: boolean; delta?: StateDelta };

/** What a handler for declaration `S` receives — and all it receives. */
type Inputs<S extends RouteInputSpec> = DeclaredRouteInputs<S>;

function captureDelta<T>(fn: (onDelta: (delta: StateDelta) => void) => T): { value: T; delta: StateDelta } {
  let delta: StateDelta = null;
  const value = fn((d) => { delta = d; });
  return { value, delta };
}

export function registerGitHubRoutes(session: Hono, { domain, recorder }: RouteContext<GitHubDomain>): void {
  /**
   * Mount one declared route.
   *
   * `tool` is typed to `TAPE_ASSERTABLE_TOOLS` (F-1125), so a name outside the
   * set cannot be stamped and a set member with no stamped route is caught by
   * `test/tool-stamping.test.ts`. A `was never called` check is only as honest
   * as the doors the recorder watches, and the two halves drifting apart is how
   * it would quietly start lying.
   */
  const route = <S extends RouteInputSpec>(
    declaration: RouteInputDeclaration<S>,
    handler: (input: Inputs<S>, c: Context) => HandleResult | Promise<HandleResult>,
    tool?: (typeof TAPE_ASSERTABLE_TOOLS)[number]
  ): void => {
    mountDeclaredRoute(
      session,
      declaration,
      recorder.handle({ mutation: false, ...(tool ? { tool } : {}) }, async (c) => {
        const input = await parseDeclared(declaration, c);
        const result = await handler(input, c);
        return {
          status: result.status,
          body: result.body,
          mutation: result.mutation ?? false,
          delta: result.delta ?? null,
        };
      })
    );
  };

  // ----- search -----
  route(GITHUB_ROUTES.searchRepositories, ({ query }) => ok(domain.searchRepositories(query)));
  route(GITHUB_ROUTES.searchCode, ({ query }) => ok(domain.searchCode(query)));
  route(GITHUB_ROUTES.searchIssues, ({ query }) => ok(domain.searchIssues(query)));
  route(GITHUB_ROUTES.searchUsers, ({ query }) => ok(domain.searchUsers(query)));
  route(GITHUB_ROUTES.searchCommits, ({ query }) => ok(domain.searchCommits(query)));

  // ----- repositories -----
  route(GITHUB_ROUTES.getRepository, ({ path }) => ok(domain.getRepository(path)));
  route(GITHUB_ROUTES.createUserRepository, ({ body }) => {
    const { value, delta } = captureDelta((onDelta) => domain.createRepository(body, onDelta));
    return created(value, delta);
  });
  route(GITHUB_ROUTES.createOrgRepository, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createRepository({ ...body, owner: path.owner }, onDelta)
    );
    return created(value, delta);
  });
  route(GITHUB_ROUTES.forkRepository, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.forkRepository({ ...path, ...body }, onDelta)
    );
    return created(value, delta);
  });

  // ----- contents & commits -----
  route(GITHUB_ROUTES.getRepositoryRootContents, ({ path, query }) =>
    ok(domain.getFileContents({ owner: path.owner, repo: path.repo, path: "", ref: query.ref }))
  );
  route(GITHUB_ROUTES.getFileContents, ({ path, query }) =>
    ok(domain.getFileContents({ ...path, ref: query.ref }))
  );
  route(GITHUB_ROUTES.createOrUpdateFile, ({ path, body }, c) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createOrUpdateFile({ ...path, ...body }, { actor: sessionLogin(c) }, onDelta)
    );
    // GitHub returns 201 Created when the file did not previously exist and 200
    // OK when an existing file is updated (FDRS-596). The domain reports a
    // `before: null` delta for an insert (documented convention in
    // shared-types' stateDeltaSchema).
    const status = delta !== null && delta.before === null ? 201 : 200;
    return { status, body: value, mutation: true, delta };
  });
  route(GITHUB_ROUTES.listCommits, ({ path, query }) => ok(domain.listCommits({ ...path, ...query })));
  route(GITHUB_ROUTES.createRef, ({ path, body }) => {
    const branch = body.ref.replace(/^refs\/heads\//, "");
    const { value, delta } = captureDelta((onDelta) =>
      domain.createBranch({ ...path, branch, sha: body.sha }, onDelta)
    );
    return created(value, delta);
  });

  // ----- issues -----
  route(GITHUB_ROUTES.listIssues, ({ path, query }) => ok(domain.listIssues({ ...path, ...query })));
  route(GITHUB_ROUTES.createIssue, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) => domain.createIssue({ ...path, ...body }, onDelta));
    return created(value, delta);
  });
  route(GITHUB_ROUTES.getIssue, ({ path }) => ok(domain.getIssue(issueRef(path))));
  route(GITHUB_ROUTES.updateIssue, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.updateIssue({ ...issueRef(path), ...body }, onDelta)
    );
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.listIssueComments, ({ path, query }) =>
    ok(domain.listIssueComments({ ...issueRef(path), ...query }))
  );
  route(GITHUB_ROUTES.addIssueComment, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.addIssueComment({ ...issueRef(path), ...body }, onDelta)
    );
    return created(value, delta);
  });
  route(GITHUB_ROUTES.listRepositoryLabels, ({ path }) => ok(domain.listRepositoryLabels(path)));
  route(GITHUB_ROUTES.createRepositoryLabel, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createRepositoryLabel({ ...path, ...body }, onDelta)
    );
    return created(value, delta);
  });
  route(GITHUB_ROUTES.listIssueLabels, ({ path }) => ok(domain.listIssueLabelsForIssue(issueRef(path))));
  route(GITHUB_ROUTES.addIssueLabels, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.addIssueLabels({ ...issueRef(path), ...body }, onDelta)
    );
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.deleteIssueLabel, ({ path }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.deleteIssueLabel({ ...issueRef(path), label: path.name }, onDelta)
    );
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.listCollaborators, ({ path }) => ok(domain.listCollaborators(path)));
  route(GITHUB_ROUTES.checkCollaborator, ({ path }) => {
    if (!domain.isCollaborator(path)) throw new TwinError("Not Found", 404);
    return { status: 204, body: null, mutation: false };
  });
  route(GITHUB_ROUTES.addAssignees, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.addAssignees({ ...issueRef(path), ...body }, onDelta)
    );
    return created(value, delta);
  });

  // ----- pull requests -----
  route(GITHUB_ROUTES.listPullRequests, ({ path, query }) =>
    ok(domain.listPullRequests({ ...path, ...query }))
  );
  route(GITHUB_ROUTES.createPullRequest, ({ path, body }, c) => {
    const args = { ...path, ...body, actor: sessionLogin(c) };
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequest(args, onDelta));
    return created(value, delta);
  });
  route(GITHUB_ROUTES.getPullRequest, ({ path }) => ok(domain.getPullRequest(pullRef(path))));
  route(GITHUB_ROUTES.listPullRequestFiles, ({ path, query }) =>
    ok(domain.getPullRequestFiles({ ...pullRef(path), ...query }))
  );
  route(GITHUB_ROUTES.listPullRequestReviews, ({ path, query }) =>
    ok(domain.getPullRequestReviews({ ...pullRef(path), ...query }))
  );
  route(GITHUB_ROUTES.createPullRequestReview, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createPullRequestReview({ ...pullRef(path), ...body }, onDelta)
    );
    return created(value, delta);
  });
  route(GITHUB_ROUTES.listPullRequestComments, ({ path, query }) =>
    ok(domain.getPullRequestComments({ ...pullRef(path), ...query }))
  );
  route(GITHUB_ROUTES.getPullRequestStatus, ({ path }) => ok(domain.getPullRequestStatus(pullRef(path))));
  route(GITHUB_ROUTES.mergePullRequest, ({ path, body }, c) => {
    const args = { ...pullRef(path), ...body };
    const actor = sessionLogin(c);
    if (
      !actor ||
      !domain.hasRepositoryPermission({
        owner: args.owner,
        repo: args.repo,
        username: actor,
        permissions: ["push", "maintain", "admin"],
      })
    ) {
      throw new TwinError("Must have push access to the repository to merge pull requests.", 403);
    }
    const { value, delta } = captureDelta((onDelta) => domain.mergePullRequest(args, onDelta));
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.updatePullRequestBranch, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.updatePullRequestBranch({ ...pullRef(path), ...body }, onDelta)
    );
    return ok(value, true, delta);
  });

  // ===== v2 hot paths (FDRS-300) =========================================
  // Cluster A — branches & files
  route(GITHUB_ROUTES.listBranches, ({ path, query }) =>
    ok(domain.listBranchesForRepo({ ...path, ...query }))
  );
  route(GITHUB_ROUTES.getBranch, ({ path }) => ok(domain.getBranchByName(path)));
  route(GITHUB_ROUTES.deleteBranch, ({ path }) => {
    const { delta } = captureDelta((onDelta) => domain.deleteBranch(path, onDelta));
    return { status: 204, body: null, mutation: true, delta };
  });
  route(GITHUB_ROUTES.deleteFile, ({ path, body }, c) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.deleteFile({ ...path, ...body }, { actor: sessionLogin(c) }, onDelta)
    );
    return ok(value, true, delta);
  });

  // Cluster B — commits & diffs
  route(GITHUB_ROUTES.getCommit, ({ path }) => ok(domain.getCommitWithFiles(path)));
  route(GITHUB_ROUTES.compareCommits, ({ path }) => {
    const parts = path.basehead.split("...");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new TwinError("Invalid compare ref. Expected 'base...head'.", 422);
    }
    return ok(
      domain.compareCommits({ owner: path.owner, repo: path.repo, base: parts[0], head: parts[1] })
    );
  });
  route(GITHUB_ROUTES.getPullRequestDiff, ({ path }) => ok(domain.getPullRequestDiff(pullRef(path))));

  // Cluster C — pull requests deeper
  route(GITHUB_ROUTES.updatePullRequest, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.updatePullRequest({ ...pullRef(path), ...body }, onDelta)
    );
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.listPullRequestCommits, ({ path, query }) =>
    ok(domain.getPullRequestCommits({ ...pullRef(path), ...query }))
  );
  route(GITHUB_ROUTES.createPullRequestReviewComment, ({ path, body }, c) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createPullRequestReviewComment(
        { ...pullRef(path), ...body },
        { actor: sessionLogin(c) },
        onDelta
      )
    );
    return created(value, delta);
  });
  route(GITHUB_ROUTES.replyToPullRequestReviewComment, ({ path, body }, c) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.addReplyToPullRequestComment(
        { ...pullRef(path), comment_id: path.comment_id, ...body },
        { actor: sessionLogin(c) },
        onDelta
      )
    );
    return created(value, delta);
  });

  // Cluster D — issue comments deeper
  route(GITHUB_ROUTES.updateIssueComment, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.updateIssueComment({ ...path, ...body }, onDelta)
    );
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.deleteIssueComment, ({ path }) => {
    const { delta } = captureDelta((onDelta) => domain.deleteIssueComment(path, onDelta));
    return { status: 204, body: null, mutation: true, delta };
  });

  // Cluster E — milestones
  route(GITHUB_ROUTES.listMilestones, ({ path, query }) =>
    ok(domain.listMilestones({ ...path, ...query }))
  );
  route(GITHUB_ROUTES.createMilestone, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createMilestone({ ...path, ...body }, onDelta)
    );
    return created(value, delta);
  });
  route(GITHUB_ROUTES.updateMilestone, ({ path, body }) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.updateMilestone({ ...milestoneRef(path), ...body }, onDelta)
    );
    return ok(value, true, delta);
  });
  route(GITHUB_ROUTES.deleteMilestone, ({ path }) => {
    const { delta } = captureDelta((onDelta) => domain.deleteMilestone(milestoneRef(path), onDelta));
    return { status: 204, body: null, mutation: true, delta };
  });

  // Cluster F — commit status + checks
  route(
    GITHUB_ROUTES.createCommitStatus,
    ({ path, body }) => {
      const { value, delta } = captureDelta((onDelta) =>
        domain.createCommitStatus({ ...path, ...body }, onDelta)
      );
      return created(value, delta);
    },
    "create_commit_status"
  );
  route(GITHUB_ROUTES.getCombinedStatusForRef, ({ path }) => ok(domain.getCombinedStatusForRef(path)));
  route(
    GITHUB_ROUTES.createCheckRun,
    ({ path, body }) => {
      const { value, delta } = captureDelta((onDelta) =>
        domain.createCheckRun({ ...path, ...body }, onDelta)
      );
      return created(value, delta);
    },
    "create_check_run"
  );
  route(GITHUB_ROUTES.listCheckRunsForRef, ({ path, query }) =>
    ok(domain.listCheckRunsForRef({ ...path, ...query }))
  );

  // Cluster G — tags & releases
  route(GITHUB_ROUTES.listTags, ({ path, query }) => ok(domain.listTags({ ...path, ...query })));
  route(GITHUB_ROUTES.listReleases, ({ path, query }) => ok(domain.listReleases({ ...path, ...query })));
  route(GITHUB_ROUTES.getLatestRelease, ({ path }) => ok(domain.getLatestRelease(path)));
  route(GITHUB_ROUTES.getReleaseByTag, ({ path }) => ok(domain.getReleaseByTag(path)));
  route(GITHUB_ROUTES.createRelease, ({ path, body }, c) => {
    const { value, delta } = captureDelta((onDelta) =>
      domain.createRelease({ ...path, ...body }, { actor: sessionLogin(c) }, onDelta)
    );
    return created(value, delta);
  });

  // Cluster H — identity & collaborators
  route(GITHUB_ROUTES.getAuthenticatedUser, (_input, c) => ok(domain.getMe({ actor: sessionLogin(c) })));
  route(GITHUB_ROUTES.addCollaborator, ({ path, body }, c) => {
    const actor = sessionLogin(c);
    if (
      !actor ||
      !domain.hasRepositoryPermission({
        owner: path.owner,
        repo: path.repo,
        username: actor,
        permissions: ["push", "maintain", "admin"],
      })
    ) {
      throw new TwinError("Must have push access to the repository to add collaborators.", 403);
    }
    const { value, delta } = captureDelta((onDelta) =>
      domain.addCollaboratorAction({ ...path, permission: body.permission, actor }, onDelta)
    );
    return { status: value.status, body: value.body, mutation: true, delta };
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Project the declaration's refusals into github's frozen error envelope.
 *
 * An undeclared query or body key becomes the same 422 "Validation Failed" the
 * twin already returns for a declared input that fails its own schema (a
 * `ZodError` lands there via `githubErrorEnvelope`), and an unparseable body
 * becomes the frozen 400 "Problems parsing JSON".
 */
async function parseDeclared<S extends RouteInputSpec>(
  declaration: RouteInputDeclaration<S>,
  c: Context
): Promise<DeclaredRouteInputs<S>> {
  try {
    return await declaration.parse(c.req);
  } catch (error) {
    if (error instanceof UndeclaredInputError) validationFailed(error.first, "invalid");
    if (error instanceof MalformedBodyError) throw new SyntaxError("Problems parsing JSON");
    throw error;
  }
}

function ok(body: unknown, mutation = false, delta: StateDelta = null): HandleResult {
  return { status: 200, body, mutation, delta };
}

function created(body: unknown, delta: StateDelta = null): HandleResult {
  return { status: 201, body, mutation: true, delta };
}

/** The caller's identity from the verified session claim — not a route input. */
function sessionLogin(c: Context): string | undefined {
  const session = c.get("session") as { login?: unknown } | undefined;
  return typeof session?.login === "string" ? session.login : undefined;
}

// GitHub's URL spells all three of these `:number`; the domain names the
// resource it belongs to. One rename each, in one place.
function issueRef(path: { owner: string; repo: string; number: number }) {
  return { owner: path.owner, repo: path.repo, issue_number: path.number };
}

function pullRef(path: { owner: string; repo: string; number: number }) {
  return { owner: path.owner, repo: path.repo, pull_number: path.number };
}

function milestoneRef(path: { owner: string; repo: string; number: number }) {
  return { owner: path.owner, repo: path.repo, milestone_number: path.number };
}
