// SPDX-License-Identifier: Apache-2.0
//
// What the recorder captures FROM THE REQUEST.
//
// One module because there are five emission sites — the engine's `handle()`
// middleware, the JSON-RPC tool dispatch, the failure injector, and two of
// stripe's own hand-built recorders — and "which headers get recorded" and
// "what counts as the tool that was called" have to have exactly one answer
// across all of them. Five copies of that policy is five chances for a twin to
// be the one whose tape a header-reading check cannot see, and the failure is
// silent: a task author reading `The retry includes X-PAYMENT` has no way to
// learn that the surface they targeted was the one that never captured it.

import type { Context } from "hono";

/**
 * The request headers a recorded event carries.
 *
 * WHOLESALE, no allowlist. An allowlist is a narrowing no downstream consumer
 * can lift and no task author can extend, which is the defect this field exists
 * to remove: `The retry includes X-PAYMENT` was unanswerable at any substrate
 * width because the recorder captured nothing at all.
 *
 * Secrets are handled where every other field's are: `createRecorderHandle`
 * runs `redactEvent` before any store sees the event, and `HARD_REDACT_KEYS`
 * covers `authorization` / `cookie` / `x-api-key` by key. Both directions are
 * pinned in `test/redaction.test.ts` — the bearer must die, and `x-payment`
 * (base64 JSON, so its value always begins `eyJ`, one character class away from
 * the JWT scrubber) must survive.
 *
 * Hono's `Headers` iteration lowercases every name, so a check reading
 * `x-payment` never has to guess the casing the agent sent.
 */
export function recordedRequestHeaders(c: Context): Record<string, string> {
  return c.req.header();
}

// Where a dispatch surface parks the tool name it resolved, for the recorder to
// read. A context stash rather than a return value because the name has to
// survive the THROW path: `/mcp/call` learns the tool from the request body and
// then `findTool` can throw on it, and an unknown-tool attempt recorded as
// `tool: null` would be invisible to the very check that asks whether the agent
// reached for it.
const RECORDED_TOOL_KEY = "pomeRecordedTool";

/**
 * Declare the twin action this request invoked, for surfaces that only learn it
 * at request time (the MCP dispatch routes read it from a path param or the
 * request body). Wins over the static `handle({ tool })` declaration.
 *
 * Call it as soon as the name is known and BEFORE any validation that can
 * throw — the point is that a rejected attempt still names what was attempted.
 */
export function setRecordedTool(c: Context, tool: string): void {
  c.set(RECORDED_TOOL_KEY as never, tool as never);
}

/** The action stamped on this request, preferring a dispatch-time name. */
export function resolveRecordedTool(c: Context, declared?: string): string | null {
  const stashed = c.get(RECORDED_TOOL_KEY as never) as unknown;
  if (typeof stashed === "string" && stashed.length > 0) return stashed;
  return declared && declared.length > 0 ? declared : null;
}
