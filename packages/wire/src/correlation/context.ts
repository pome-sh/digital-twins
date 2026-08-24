// SPDX-License-Identifier: Apache-2.0
//
// correlation/context — the AsyncLocalStorage store that carries the current
// tool call's id, framework-agnostic.
//
// WHAT THIS IS FOR. A twin records one `TwinHttpEvent` per inbound HTTP request.
// For that row to have a parent, the twin has to be told which tool call issued
// the request, and the only channel available is the request itself — an agent
// framework does not hand its HTTP client a trace context. So the agent side
// stamps the id onto an outgoing header (`./fetch.ts`) and the twin persists it
// as `TwinHttpEvent.tool_call_id`.
//
// WHY AsyncLocalStorage AND NOT A MODULE-LEVEL VARIABLE. Tool handlers run
// concurrently: `Promise.all` over three tool calls, each `await`ing its own
// fetches, interleaves them on one event loop. A module-level "current id" would
// be whatever the last handler to start happened to set, so the third call's
// HTTP rows would be parented to the first call. ALS gives each handler
// invocation its own store that survives every `await`, `setTimeout` and
// `Promise.all` inside it, and is invisible to its siblings. That is the
// race-proofness this module exists to provide, and it is the property
// `test/correlation-context.test.ts` pins.
//
// WHY IT LIVES IN wire AND NOT IN AN ADAPTER. Nothing below knows what
// a Claude tool is. Establishing the scope is the framework-specific half — the
// Claude adapter reads the SDK's real `tool_use_id` off an MCP `_meta` key,
// a Vercel AI SDK adapter would read `toolCallId` off `experimental_telemetry`
// / the tool-call part, a LangGraph adapter off the `ToolCall` node — but the
// store, the id vocabulary, and the header injection are the same guarantee in
// all three. Wire already owns `TwinHttpEvent.tool_call_id`, the field this
// value lands in, so wire owns the plumbing that carries it there.
//
// ONE STORE PER LOADED COPY OF THIS MODULE. `correlationContext` is a
// module-level singleton, which means it is per *module instance*, not per
// process. Wire is `private: true` and inlined into each published package via
// tsup's `noExternal`, so two pome adapters loaded in one process would each
// carry their own store and their own fetch patch. That composes correctly
// rather than silently: the outer fetch patch reads its own (empty) store,
// declines to inject, and delegates to the inner patch, which reads the store
// its own `withCorrelation` set. Each adapter therefore correlates the calls it
// wrapped, and neither steals the other's.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-tool-call state carried through the async context.
 *
 * `tool_call_id` is deliberately snake_case: it is the same field, with the same
 * name, as `TwinHttpEvent.tool_call_id` in `recorder-events.ts`. Renaming it
 * here would put a translation step between the value and the row it becomes.
 *
 * The id itself is opaque to this module — a framework's own tool-call id
 * (`toolu_…` from the Claude Agent SDK) is preferred, because that is what
 * downstream `ToolUseEvent.tool_use_id` rows join on; `./id.ts` mints a
 * synthetic `tlc_…` only as a fallback for runtimes that expose no id.
 */
export type CorrelationContext = { tool_call_id: string };

/**
 * The store. Exported as the escape hatch for callers that need
 * AsyncLocalStorage semantics `withCorrelation` does not expose (`enterWith`
 * for a long-lived stream scope, `exit` to deliberately drop correlation for a
 * nested call). Prefer `withCorrelation`.
 */
export const correlationContext = new AsyncLocalStorage<CorrelationContext>();

/**
 * Run `fn` with `tool_call_id` as the current correlation id. Every outgoing
 * `fetch()` to an allowlisted twin origin made inside `fn` — including from
 * `await`ed continuations and nested promises — carries that id on the
 * `x-pome-correlation-id` header, provided `installCorrelationFetchHook()` ran.
 *
 * The return value and sync/async-ness of `fn` are passed straight through, so
 * this wraps a sync handler without forcing it to become a promise:
 *
 *     // framework adapter, tool-invocation boundary
 *     const id = readFrameworkToolCallId(call) ?? generateToolCallId();
 *     return withCorrelation(id, () => handler(args));
 *
 * Nesting replaces the id for the inner scope only; the outer scope's id is
 * restored when `fn` returns. Exceptions propagate untouched and the scope is
 * torn down either way — ALS unwinds with the stack, so there is no leak to
 * clean up in a `finally`.
 */
export function withCorrelation<R>(tool_call_id: string, fn: () => R): R {
  return correlationContext.run({ tool_call_id }, fn);
}

/**
 * The current correlation id, or `null` outside any `withCorrelation` scope.
 *
 * `null` is a normal, expected answer and not an error: it is how the fetch hook
 * distinguishes a call made from inside a wrapped tool handler from one made by
 * the framework's own machinery (the Anthropic SDK's requests to
 * api.anthropic.com originate outside every handler scope), and the latter must
 * pass through untouched.
 */
export function currentToolCallId(): string | null {
  return correlationContext.getStore()?.tool_call_id ?? null;
}
