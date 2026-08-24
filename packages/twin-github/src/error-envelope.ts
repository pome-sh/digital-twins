// SPDX-License-Identifier: Apache-2.0
//
// GitHub's wire-frozen error projection, and the per-door url attachment
// the operation-url work hangs off it.
//
// It moved out of `twin.ts` because `routes.ts` needs it too: the manifest
// installs this as the twin-wide `errorEnvelope`, and each mounted route
// installs `operationErrorEnvelope(<its own url>)` as a per-call override
// through `recorder.handle({ errorEnvelope })`. Both are the same projection —
// there is exactly one place that decides what a GitHub error body looks like.

import { ZodError } from "zod";
import { UnknownToolError } from "@pome-sh/sdk/server";
import { TwinError, githubError, withOperationDocs } from "./errors.js";

// The engine's `/mcp/call` parses with its own zod instance, so a bare
// `instanceof ZodError` can miss; fall back to the duck check on `name`.
function zodIssues(err: unknown): Array<{ path: ReadonlyArray<PropertyKey>; code?: string }> | undefined {
  if (err instanceof ZodError) return err.issues;
  if (err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as unknown as ZodError).issues;
  }
  return undefined;
}

/**
 * Wire-frozen GitHub error projection: `{message, documentation_url,
 * status, errors?}` (githubError). Statuses: TwinError carries its own;
 * validation (Zod or unknown tool) → 422 "Validation Failed"; JSON parse →
 * 400; anything else → 500 so platform retries / alerting kick in.
 */
export function githubErrorEnvelope(err: unknown): { status: number; body: unknown } {
  if (err instanceof UnknownToolError) {
    // Frozen legacy-dispatch behavior: an unknown tool is a 422 validation
    // failure on the `tool` field (pre-port executeTool → validationFailed).
    return {
      status: 422,
      body: githubError("Validation Failed", 422, [
        { resource: "Request", field: "tool", code: "invalid", value: err.tool },
      ]),
    };
  }
  if (err instanceof TwinError) {
    return {
      status: err.status,
      body: githubError(err.message, err.status, err.errors, err.documentationUrl),
    };
  }
  const issues = zodIssues(err);
  if (issues) {
    return {
      status: 422,
      body: githubError(
        "Validation Failed",
        422,
        issues.map((issue) => ({
          resource: "Request",
          field: issue.path.join("."),
          code: issue.code,
        }))
      ),
    };
  }
  if (err instanceof SyntaxError) {
    return { status: 400, body: githubError("Problems parsing JSON", 400) };
  }
  return {
    status: 500,
    body: githubError(err instanceof Error ? err.message : "Internal Server Error", 500),
  };
}

/**
 * The same projection with one route's operation url attached.
 *
 * `undefined` gives the plain projection back rather than a wrapper that does
 * nothing, so the twin-only routes are literally the twin-wide behavior — there
 * is no second code path for them to drift down.
 */
export function operationErrorEnvelope(
  documentationUrl: string | undefined
): (err: unknown) => { status: number; body: unknown } {
  if (documentationUrl === undefined) return githubErrorEnvelope;
  return (err) => withOperationDocs(githubErrorEnvelope(err), documentationUrl);
}
