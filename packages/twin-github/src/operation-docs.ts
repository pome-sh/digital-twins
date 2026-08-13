// SPDX-License-Identifier: Apache-2.0
//
// F-1498 — which GitHub operation each door of this twin stands for, and the
// `documentation_url` real GitHub puts on that operation's errors.
//
// ── WHY THIS IS A LOOKUP AND NOT A THROW-SITE CONSTANT ──────────────────────
//
// Real GitHub is operation-specific on 45 of 59 measured error responses
// (F-1490's transcript). This twin could not follow, because the SDK's hook is
// `errorEnvelope?: (err: unknown) => {status, body}` — the error and nothing
// else — while the right url depends on WHICH DOOR was knocked on: `notFound()`
// raised inside `domain.requireRepo()` is reachable from ~40 REST routes and
// ~30 MCP tools. `src/domain/git.ts` stamps two urls at their throw sites and
// says not to spread the pattern, because a `sha` conflict has exactly one
// possible operation and almost nothing else here does.
//
// So the url is attached at the DOOR instead: `routes.ts` keys on the route
// declaration's own `surface` string, and `tools.ts` keys on the tool name plus
// (for the four consolidated tools) the `method` argument it just parsed.
//
// ── WHAT THIS MODULE MAY NOT DO ─────────────────────────────────────────────
//
// It reads `fixtures/operation-docs.raw.json` and nothing else. Every url there
// is `externalDocs.url` copied out of GitHub's published OpenAPI description by
// `scripts/vendor-operation-docs.ts`; none is typed from the docs site. The
// anchors are not derivable from the path (`/rest/repos/contents#…`,
// `/rest/commits/commits#…`, `/rest/branches/branches#…`), so a url written by
// hand here would be a guess wearing a fact's clothes.
//
// A door with NO entry answers `undefined`, and its errors keep the generic
// `https://docs.github.com/rest`. That is a positive claim, not a gap: GitHub
// answers generically on three measured classes of its own, and the twin-only
// routes and the multi-leg MCP tools registered `null` in the artifact are the
// same shape of fact. See the artifact's `meta.json` for the per-entry reasons.

import artifact from "../fixtures/operation-docs.raw.json" with { type: "json" };

/** One GitHub operation, as its OpenAPI description declares it. */
export type OperationDocsRow = {
  /** The vendor's HTTP method — kept so the gate can re-check the pairing offline. */
  method: string;
  /** The vendor's templated path, e.g. `/repos/{owner}/{repo}/issues/{issue_number}`. */
  path: string;
  /** `x-github.category`, the first docs-site path segment. */
  category: string;
  /** `x-github.subcategory`, the second. Together they reproduce the anchor's path. */
  subcategory: string;
  /** `externalDocs.url` — the leaf this whole module exists to serve. */
  url: string;
};

/** How one MCP tool names the REST operation it stands for. */
export type McpOperationEntry =
  /** One tool, one operation. */
  | { operationId: string }
  /** `create_repository`: the operation depends on whether an argument was sent. */
  | { byArgument: { argument: string; present: string; absent: string } }
  /** The four consolidated tools: the operation depends on the `method` enum value. */
  | { byMethod: Record<string, string> };

export type OperationDocsArtifact = {
  operations: Record<string, OperationDocsRow>;
  /** Every REST surface this twin mounts → its operation id, or `null` for twin-only. */
  rest: Record<string, string | null>;
  /** Every MCP tool this twin serves → its operation, or `null` for unmappable. */
  mcp: Record<string, McpOperationEntry | null>;
};

const docs = artifact as unknown as OperationDocsArtifact;

/** Every vendored operation, keyed by GitHub's own operation id. */
export const OPERATION_DOCS: Readonly<Record<string, OperationDocsRow>> = docs.operations;
/** Mounted REST surface → operation id, `null` for the two twin-only routes. */
export const REST_OPERATION_IDS: Readonly<Record<string, string | null>> = docs.rest;
/** Served MCP tool → its operation, `null` for the three registered unmappable. */
export const MCP_OPERATION_ENTRIES: Readonly<Record<string, McpOperationEntry | null>> = docs.mcp;

function urlFor(operationId: string | null | undefined): string | undefined {
  if (!operationId) return undefined;
  return docs.operations[operationId]?.url;
}

/**
 * The `documentation_url` for a REST surface, keyed by the declaration's own
 * `surface` string (`"GET /repos/:owner/:repo"`).
 *
 * Keyed on the declaration rather than on the request path on purpose: the
 * declaration is what the route was MOUNTED with, so the two cannot drift, and
 * `scripts/vendor-operation-docs.ts --check` fails if the artifact's key set is
 * not exactly `GITHUB_ROUTE_INPUTS`.
 */
export function restOperationDocumentationUrl(surface: string): string | undefined {
  return urlFor(docs.rest[surface]);
}

/**
 * The `documentation_url` for an MCP tool call, after its arguments parsed.
 *
 * `args` is the PARSED arguments object, which is why this is called from
 * inside `executeTool` rather than at the tool table: `issue_read`,
 * `issue_write`, `pull_request_read` and `pull_request_review_write` each stand
 * for a different REST operation per `method`, and `create_repository` splits on
 * whether `owner` was sent (`repos/create-in-org` vs
 * `repos/create-for-authenticated-user`).
 *
 * A `method` the artifact does not list answers `undefined` — those are the
 * values this twin 501-refuses, and a refusal it invents is not a GitHub error
 * it is proxying.
 */
export function toolOperationDocumentationUrl(tool: string, args: unknown): string | undefined {
  const entry = docs.mcp[tool];
  if (!entry) return undefined;
  if ("operationId" in entry) return urlFor(entry.operationId);
  const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if ("byMethod" in entry) {
    const method = record.method;
    return typeof method === "string" ? urlFor(entry.byMethod[method]) : undefined;
  }
  const sent = record[entry.byArgument.argument] !== undefined;
  return urlFor(sent ? entry.byArgument.present : entry.byArgument.absent);
}
