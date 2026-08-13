// SPDX-License-Identifier: Apache-2.0
//
// F-1498 — the derivation behind `fixtures/operation-docs.raw.json`, and the
// invariants `--check` re-asserts without it.
//
// Split out of `vendor-operation-docs.ts` so the gate's teeth are importable:
// `test/operation-docs-gate.test.ts` feeds `verifyOperationDocs` a mutated copy
// of the committed artifact and demands a refusal. A gate whose only caller is
// a workflow line is a gate nobody has ever seen fail.
//
// ── WHAT IS DERIVED AND WHAT IS DECIDED ─────────────────────────────────────
//
// DERIVED (needs the vendor spec): every url, category and subcategory, plus 64
// of the 66 REST surface → operation pairings, resolved by PATH SHAPE — the
// twin's `/repos/:owner/:repo/issues/:number` and GitHub's
// `/repos/{owner}/{repo}/issues/{issue_number}` reduce to the same
// `/repos/*/*/issues/*`. Shape rather than name substitution because the two
// spellings genuinely differ: GitHub says `{issue_number}`, `{pull_number}` and
// `{milestone_number}` where this twin says `:number`, and `{org}` where
// `POST /orgs/:owner/repos` says `:owner`. A shape that matches zero or more
// than one operation is a hard refusal, never a guess.
//
// DECIDED (F-1498's `[DECISION]` comment, before any code): the two surfaces
// whose shapes cannot match, the two twin-only routes with no GitHub operation
// at all, the per-tool MCP mapping, and the three tools registered unmappable
// with their reasons. Those tables are here, and they are copied into the
// artifact's `meta.json` so they ship with the file rather than living only in
// a script somebody would have to go and read.

import type { McpOperationEntry, OperationDocsArtifact, OperationDocsRow } from "../src/operation-docs.js";

/** The vendor description, narrowed to the four leaves this file reads. */
export type OpenApiDescription = {
  openapi?: string;
  info?: { version?: string };
  paths: Record<string, Record<string, unknown>>;
};

type SpecOperation = {
  operationId?: string;
  externalDocs?: { url?: string };
  "x-github"?: { category?: string; subcategory?: string };
};

/**
 * Surfaces whose path shape cannot match GitHub's, and the operation each one
 * IS. Both spellings are this twin's, not GitHub's, and neither is ambiguous.
 */
export const RESOLVED_BY_HAND: Record<string, { operationId: string; reason: string }> = {
  "DELETE /repos/:owner/:repo/git/refs/heads/*": {
    operationId: "git/delete-ref",
    reason:
      "the twin hardcodes the `heads/` prefix that GitHub carries INSIDE its `{ref}` path parameter, " +
      "so the twin's shape has one more literal segment than `/repos/{owner}/{repo}/git/refs/{ref}`. " +
      "Same operation, different spelling of the same url.",
  },
  "GET /repos/:owner/:repo/contents": {
    operationId: "repos/get-content",
    reason:
      "the root-directory listing is `repos/get-content` with an empty path. GitHub declares only " +
      "`/repos/{owner}/{repo}/contents/{path}`, so the twin's extra route for the bare directory has " +
      "no shape to match — it is the same operation reached with `path` empty.",
  },
};

/**
 * Surfaces with no GitHub operation at all. These stay GENERIC, which is not a
 * gap: GitHub has no route to answer them, so it could only answer generically
 * itself. Recorded rather than omitted so a future reader cannot mistake the
 * absence for an oversight.
 */
export const TWIN_ONLY_ROUTES: Record<string, string> = {
  "GET /repos/:owner/:repo/pulls/:number/diff":
    "twin-only route, no GitHub operation — GitHub serves a PR diff off `pulls/get` with the " +
    "`.diff` media type, not off a `/diff` path, so there is no operation this url could name.",
  "GET /repos/:owner/:repo/pulls/:number/status":
    "twin-only route, no GitHub operation — GitHub's combined status is " +
    "`repos/get-combined-status-for-ref` under `/commits/{ref}/status`, which this twin also " +
    "serves separately. This convenience path is the twin's own.",
};

/**
 * The MCP door, decided per tool rather than looked up. GitHub's own MCP server
 * proxies REST errors verbatim, so a tool's error surfaces the underlying
 * operation's url — but the mapping is not 1:1 for every tool, and the three
 * where it is not are registered in `UNMAPPABLE_TOOLS` below rather than
 * guessed at.
 */
export const MCP_OPERATIONS: Record<string, McpOperationEntry> = {
  // ── 28 tools, one REST operation each ──────────────────────────────────
  search_repositories: { operationId: "search/repos" },
  fork_repository: { operationId: "repos/create-fork" },
  search_code: { operationId: "search/code" },
  search_users: { operationId: "search/users" },
  get_file_contents: { operationId: "repos/get-content" },
  list_commits: { operationId: "repos/list-commits" },
  create_or_update_file: { operationId: "repos/create-or-update-file-contents" },
  search_issues: { operationId: "search/issues-and-pull-requests" },
  list_issues: { operationId: "issues/list-for-repo" },
  add_issue_comment: { operationId: "issues/create-comment" },
  create_issue: { operationId: "issues/create" },
  list_repository_collaborators: { operationId: "repos/list-collaborators" },
  create_pull_request_review: { operationId: "pulls/create-review" },
  list_pull_requests: { operationId: "pulls/list" },
  merge_pull_request: { operationId: "pulls/merge" },
  update_pull_request_branch: { operationId: "pulls/update-branch" },
  create_pull_request: { operationId: "pulls/create" },
  list_branches: { operationId: "repos/list-branches" },
  delete_file: { operationId: "repos/delete-file" },
  get_commit: { operationId: "repos/get-commit" },
  update_pull_request: { operationId: "pulls/update" },
  add_reply_to_pull_request_comment: { operationId: "pulls/create-reply-for-review-comment" },
  list_tags: { operationId: "repos/list-tags" },
  list_releases: { operationId: "repos/list-releases" },
  get_latest_release: { operationId: "repos/get-latest-release" },
  get_me: { operationId: "users/get-authenticated" },
  search_commits: { operationId: "search/commits" },
  get_release_by_tag: { operationId: "repos/get-release-by-tag" },

  // ── 1 tool whose operation depends on an argument ──────────────────────
  // Both arms are real routes of this twin (`POST /orgs/:owner/repos` and
  // `POST /user/repos`), and `executeTool` hands the same `parsed` object to
  // `domain.createRepository` either way.
  create_repository: {
    byArgument: {
      argument: "owner",
      present: "repos/create-in-org",
      absent: "repos/create-for-authenticated-user",
    },
  },

  // ── 4 consolidated tools, one operation per `method` ───────────────────
  // A `method` absent from these maps is one this twin 501-refuses, and a
  // refusal the twin invents is not a GitHub error it is proxying.
  issue_read: {
    byMethod: {
      get: "issues/get",
      get_comments: "issues/list-comments",
      get_labels: "issues/list-labels-on-issue",
    },
  },
  issue_write: {
    byMethod: {
      create: "issues/create",
      update: "issues/update",
    },
  },
  pull_request_read: {
    byMethod: {
      get: "pulls/get",
      // GitHub serves the diff off the SAME operation via the `.diff` media
      // type; there is no separate diff operation to name.
      get_diff: "pulls/get",
      get_status: "repos/get-combined-status-for-ref",
      get_files: "pulls/list-files",
      get_commits: "pulls/list-commits",
      get_reviews: "pulls/list-reviews",
      // A pull request's CONVERSATION is issue comments (F-1151), which is
      // both GitHub's model and this twin's.
      get_comments: "issues/list-comments",
      get_review_comments: "pulls/list-review-comments",
      get_check_runs: "checks/list-for-ref",
    },
  },
  pull_request_review_write: {
    // The other four methods are 501-refused: `submit_pending` / `delete_pending`
    // need a pending-review state this twin does not model, and
    // `resolve_thread` / `unresolve_thread` have NO REST operation at all
    // upstream — they are GraphQL only.
    byMethod: { create: "pulls/create-review" },
  },
};

/**
 * Tools whose errors cannot name one operation, and why. Each is a multi-leg
 * upstream call where the url depends on WHICH LEG failed, and the MCP door has
 * never been measured — so naming one would invent a divergence in the exact
 * direction F-1498 exists to close.
 */
export const UNMAPPABLE_TOOLS: Record<string, string> = {
  push_files:
    "fans out over `git/create-tree` + `git/create-commit` + `git/update-ref` (GitHub's MCP server " +
    "builds a tree; it does NOT go through `PUT /contents/*`). None of the three is a REST surface " +
    "this twin serves, and which leg fails decides the url.",
  create_branch:
    "two legs with different operations: the base-ref read (`git/get-ref`) and the ref write " +
    "(`git/create-ref`). A missing `from_branch` fails the first, an existing branch the second. " +
    "The twin collapses both into one `domain.createBranch` call, so the failing leg is not " +
    "recoverable at the throw site.",
  get_tag:
    "two-leg read upstream — `git/get-ref` on `refs/tags/<tag>`, then `git/get-tag` on the returned " +
    "sha. The twin resolves a tag in one lookup, so a not-found here does not identify which of the " +
    "two GitHub legs would have raised it.",
};

/**
 * Reduce a path to its literal segments, with every parameter replaced by a
 * star: the twin's `/repos/:owner/:repo/issues/:number` and GitHub's
 * `/repos/{owner}/{repo}/issues/{issue_number}` reduce to the same string.
 */
export function pathShape(path: string): string {
  return path
    // hono's `:param{regex}` (this twin's `:basehead{.+}`) before the bare form.
    .replace(/:[A-Za-z_][A-Za-z0-9_]*\{[^}]*\}/g, "*")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "*")
    .replace(/\{[^}]+\}/g, "*");
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);

function operationRow(method: string, path: string, operation: SpecOperation): OperationDocsRow {
  const url = operation.externalDocs?.url;
  const category = operation["x-github"]?.category;
  const subcategory = operation["x-github"]?.subcategory;
  if (!url || !category || !subcategory) {
    throw new Error(
      `${method} ${path} (${operation.operationId}) is missing externalDocs.url or x-github ` +
        `category/subcategory. Every url this twin serves comes from those leaves; there is nothing ` +
        `to fall back to that would not be a guess.`
    );
  }
  return { method, path, category, subcategory, url };
}

/**
 * Build the artifact from the vendor description plus the twin's own doors.
 *
 * `surfaces` is `GITHUB_ROUTE_INPUTS.map(d => d.surface)` — every route the twin
 * MOUNTS, which is 66. ⚠️ NOT `route-inputs.json`, which publishes 65 because
 * `buildRouteInputArtifact` drops surfaces with zero declared inputs, and
 * `GET /user` has none. Keying the gate on the artifact instead of on the
 * declarations is how `GET /user` went missing from F-1498's own mapping table.
 *
 * `tools` is every name in `toolArgumentSchemas` — 36.
 */
export function deriveOperationDocs(input: {
  spec: OpenApiDescription;
  surfaces: readonly string[];
  tools: readonly string[];
}): { artifact: OperationDocsArtifact; resolvedByShape: number } {
  const byShape = new Map<string, Array<{ method: string; path: string; operation: SpecOperation }>>();
  const byOperationId = new Map<string, { method: string; path: string; operation: SpecOperation }>();
  for (const [path, item] of Object.entries(input.spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      const spec = operation as SpecOperation;
      if (typeof spec.operationId !== "string") continue;
      const entry = { method: method.toUpperCase(), path, operation: spec };
      const key = `${entry.method} ${pathShape(path)}`;
      byShape.set(key, [...(byShape.get(key) ?? []), entry]);
      byOperationId.set(spec.operationId, entry);
    }
  }

  const operations: Record<string, OperationDocsRow> = {};
  const need = (operationId: string, why: string) => {
    const found = byOperationId.get(operationId);
    if (!found) {
      throw new Error(
        `${why} names operation '${operationId}', which the vendor description does not declare. ` +
          `Either GitHub renamed it — in which case re-decide the mapping, do not re-spell it — or ` +
          `the id is a typo naming nothing.`
      );
    }
    operations[operationId] = operationRow(found.method, found.path, found.operation);
    return operationId;
  };

  const rest: Record<string, string | null> = {};
  let resolvedByShape = 0;
  for (const surface of [...input.surfaces].sort()) {
    if (surface in TWIN_ONLY_ROUTES) {
      rest[surface] = null;
      continue;
    }
    const hand = RESOLVED_BY_HAND[surface];
    if (hand) {
      rest[surface] = need(hand.operationId, `RESOLVED_BY_HAND['${surface}']`);
      continue;
    }
    const [method, path] = splitSurface(surface);
    const matches = byShape.get(`${method} ${pathShape(path)}`) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `${surface} matches ${matches.length} vendor operations by path shape ` +
          `(${matches.map((m) => `${m.method} ${m.path}`).join(", ") || "none"}). A surface this ` +
          `script cannot resolve MECHANICALLY has to be decided in the ticket and registered in ` +
          `RESOLVED_BY_HAND or TWIN_ONLY_ROUTES with a reason — never resolved by picking one.`
      );
    }
    const match = matches[0]!;
    rest[surface] = need(match.operation.operationId!, surface);
    resolvedByShape += 1;
  }

  const mcp: Record<string, McpOperationEntry | null> = {};
  for (const tool of [...input.tools].sort()) {
    if (tool in UNMAPPABLE_TOOLS) {
      mcp[tool] = null;
      continue;
    }
    const entry = MCP_OPERATIONS[tool];
    if (!entry) {
      throw new Error(
        `the twin serves MCP tool '${tool}' and neither MCP_OPERATIONS nor UNMAPPABLE_TOOLS names ` +
          `it. Every tool is either decided or registered unmappable WITH A REASON — dropping one ` +
          `to unmappable to make this pass is the divergence F-1498 exists to close.`
      );
    }
    if ("operationId" in entry) need(entry.operationId, `MCP_OPERATIONS['${tool}']`);
    else if ("byMethod" in entry) {
      for (const [method, operationId] of Object.entries(entry.byMethod)) {
        need(operationId, `MCP_OPERATIONS['${tool}'].byMethod['${method}']`);
      }
    } else {
      need(entry.byArgument.present, `MCP_OPERATIONS['${tool}'].byArgument.present`);
      need(entry.byArgument.absent, `MCP_OPERATIONS['${tool}'].byArgument.absent`);
    }
    mcp[tool] = entry;
  }

  const sorted: Record<string, OperationDocsRow> = {};
  for (const id of Object.keys(operations).sort()) sorted[id] = operations[id]!;
  return { artifact: { operations: sorted, rest, mcp }, resolvedByShape };
}

function splitSurface(surface: string): [string, string] {
  const at = surface.indexOf(" ");
  return [surface.slice(0, at), surface.slice(at + 1)];
}

/**
 * Everything about the committed artifact that can be re-checked WITHOUT the
 * 12.9 MB vendor description, which is what CI has.
 *
 * The split is deliberate. `rest` and `mcp` carry operation IDS, not urls, so
 * every pairing this script DECIDES is re-derivable offline and is compared key
 * by key. Only `operations` needs the vendor bytes, and its two committed
 * columns check each other: `url` must be exactly
 * `https://docs.github.com/rest/<category>/<subcategory>#<anchor>`, which is the
 * relationship that made `x-github.category`/`subcategory` worth committing at
 * all. Pass `--spec` (or set POME_GITHUB_OPENAPI) to also re-derive the urls
 * themselves and byte-diff the whole file.
 */
export function verifyOperationDocs(input: {
  artifact: OperationDocsArtifact;
  surfaces: readonly string[];
  /** Tool name → the `method` values its zod schema accepts, for the four that take one. */
  toolMethods: Record<string, readonly string[] | undefined>;
}): string[] {
  const problems: string[] = [];
  const { artifact } = input;

  const expectedSurfaces = [...input.surfaces].sort();
  const actualSurfaces = Object.keys(artifact.rest).sort();
  if (JSON.stringify(expectedSurfaces) !== JSON.stringify(actualSurfaces)) {
    const missing = expectedSurfaces.filter((s) => !artifact.rest[s] && !(s in artifact.rest));
    const extra = actualSurfaces.filter((s) => !expectedSurfaces.includes(s));
    problems.push(
      `rest keys are not the twin's mounted surfaces. Mounted and unmapped: [${missing.join(", ")}]; ` +
        `mapped and not mounted: [${extra.join(", ")}].`
    );
  }

  const expectedTools = Object.keys(input.toolMethods).sort();
  const actualTools = Object.keys(artifact.mcp).sort();
  if (JSON.stringify(expectedTools) !== JSON.stringify(actualTools)) {
    problems.push(
      `mcp keys are not the twin's served tools. Served and unmapped: ` +
        `[${expectedTools.filter((t) => !actualTools.includes(t)).join(", ")}]; mapped and not ` +
        `served: [${actualTools.filter((t) => !expectedTools.includes(t)).join(", ")}].`
    );
  }

  for (const [surface, operationId] of Object.entries(artifact.rest)) {
    if (operationId === null) {
      if (!(surface in TWIN_ONLY_ROUTES)) {
        problems.push(
          `${surface} is mapped to no operation and TWIN_ONLY_ROUTES gives no reason for it. A ` +
            `surface answering the generic url is a claim about GitHub, so it needs one.`
        );
      }
      continue;
    }
    const row = artifact.operations[operationId];
    if (!row) {
      problems.push(`${surface} names operation '${operationId}', which operations does not carry.`);
      continue;
    }
    if (surface in RESOLVED_BY_HAND) {
      if (RESOLVED_BY_HAND[surface]!.operationId !== operationId) {
        problems.push(
          `${surface} is mapped to '${operationId}' and RESOLVED_BY_HAND says ` +
            `'${RESOLVED_BY_HAND[surface]!.operationId}'.`
        );
      }
      continue;
    }
    const [method, path] = splitSurface(surface);
    if (method !== row.method || pathShape(path) !== pathShape(row.path)) {
      problems.push(
        `${surface} is mapped to '${operationId}' (${row.method} ${row.path}), whose path shape is ` +
          `not the surface's. Either the pairing is wrong or it needs a RESOLVED_BY_HAND reason.`
      );
    }
  }

  for (const [tool, entry] of Object.entries(artifact.mcp)) {
    if (entry === null) {
      if (!(tool in UNMAPPABLE_TOOLS)) {
        problems.push(
          `${tool} is mapped to no operation and UNMAPPABLE_TOOLS gives no reason for it. Dropping a ` +
            `tool to unmappable without one is how the mapping quietly stops being a decision.`
        );
      }
      continue;
    }
    const decided = MCP_OPERATIONS[tool];
    if (!decided || JSON.stringify(decided) !== JSON.stringify(entry)) {
      // Reported, not returned early: the checks below say WHAT is wrong with
      // the entry, and a caller re-deriving the table wants both halves.
      problems.push(`${tool}'s mapping is not the one MCP_OPERATIONS decides.`);
    }
    const ids =
      "operationId" in entry
        ? [entry.operationId]
        : "byMethod" in entry
          ? Object.values(entry.byMethod)
          : [entry.byArgument.present, entry.byArgument.absent];
    for (const id of ids) {
      if (!artifact.operations[id]) {
        problems.push(`${tool} names operation '${id}', which operations does not carry.`);
      }
    }
    if ("byMethod" in entry) {
      const accepted = input.toolMethods[tool];
      if (!accepted) {
        problems.push(`${tool} maps per method, and its schema declares no \`method\` enum to map.`);
      } else {
        for (const method of Object.keys(entry.byMethod)) {
          if (!accepted.includes(method)) {
            problems.push(
              `${tool} maps method '${method}', which its zod schema does not accept — the mapping ` +
                `names a door that cannot be knocked on.`
            );
          }
        }
      }
    }
  }

  const referenced = new Set<string>();
  for (const id of Object.values(artifact.rest)) if (id) referenced.add(id);
  for (const entry of Object.values(artifact.mcp)) {
    if (!entry) continue;
    if ("operationId" in entry) referenced.add(entry.operationId);
    else if ("byMethod" in entry) for (const id of Object.values(entry.byMethod)) referenced.add(id);
    else {
      referenced.add(entry.byArgument.present);
      referenced.add(entry.byArgument.absent);
    }
  }
  for (const id of Object.keys(artifact.operations)) {
    if (!referenced.has(id)) {
      problems.push(
        `operations carries '${id}', which no door names. The artifact is what this twin needs, not ` +
          `a copy of GitHub's 808 paths.`
      );
    }
  }

  for (const [id, row] of Object.entries(artifact.operations)) {
    const prefix = `https://docs.github.com/rest/${row.category}/${row.subcategory}#`;
    if (!row.url.startsWith(prefix) || row.url.length === prefix.length) {
      problems.push(
        `${id}'s url '${row.url}' is not '${prefix}<anchor>'. category/subcategory are committed ` +
          `precisely because they reproduce the anchor's path, so the two disagreeing means one of ` +
          `them was edited by hand.`
      );
    }
  }

  return problems;
}
