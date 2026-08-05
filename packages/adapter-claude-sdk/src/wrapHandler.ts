// SPDX-License-Identifier: Apache-2.0
//
// Wraps an MCP tool handler so each invocation runs inside an
// AsyncLocalStorage scope carrying the tool call's id. The fetch hook in
// `@pome-sh/wire/correlation` reads that id from ALS and stamps it onto the
// `x-pome-correlation-id` header for allowlisted twin origins, so the twin's
// `TwinHttpEvent` row can be correlated back to the calling tool invocation.
//
// F-950: the store, the header injection and the fallback id minter are
// framework-agnostic and now live in `@pome-sh/wire/correlation`. THIS FILE IS
// THE CLAUDE-SPECIFIC HALF, and it is a small one: read the Claude Agent SDK's
// own `tool_use_id` off the MCP `_meta` key its CLI stamps, then open a
// correlation scope around the handler. A Vercel AI SDK or LangGraph adapter
// would replace `readSdkToolUseId` and reuse everything else verbatim.
//
// FDRS-407: no longer writes a legacy `tool_call` signal. The on-disk
// `ToolUseEvent` row is emitted by the message-stream wrapper (FDRS-408)
// from the SDK assistant message that issued the tool_use block.
//
// F-1200: the id is now the SDK's REAL `tool_use_id` rather than a freshly
// minted `tlc_<random>`. The minted id named nothing — `ToolUseEvent.tool_use_id`
// is the SDK's `toolu_…` — so nothing downstream could join a twin HTTP row back
// to the tool call that caused it, and every twin row stayed an orphan with a
// null parent. See `readSdkToolUseId` for where the real id comes from.

import { generateToolCallId, withCorrelation } from "@pome-sh/wire/correlation";

// The MCP `_meta` key the Claude Code CLI stamps on every `tools/call` it
// dispatches to an in-process SDK MCP server. Measured against
// @anthropic-ai/claude-agent-sdk 0.3.218 + Claude Code CLI 2.1.220: the value
// equals the assistant stream's `tool_use.id`, and the CLI's dispatcher reads
// `let Y = dw_(V), re = Y ? {"claudecode/toolUseId": Y} : {}`.
//
// This is a CLI-side convention, NOT a typed SDK contract: `tool()`'s `extra`
// parameter is `unknown` in sdk.d.ts, the key appears nowhere in the SDK
// package itself, and the CLI emits it CONDITIONALLY. Every read below is
// therefore tolerant with a fallback — throwing here would take down a tool
// call over a trace-linkage detail, which is strictly worse than a trace whose
// twin rows fall back to the old unjoinable id.
export const SDK_TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

/**
 * Read the SDK's `tool_use_id` off an MCP handler's `extra` argument, or null
 * when this runtime does not supply one.
 */
export function readSdkToolUseId(extra: unknown): string | null {
  if (typeof extra !== "object" || extra === null) return null;
  const meta = (extra as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return null;
  const id = (meta as Record<string, unknown>)[SDK_TOOL_USE_ID_META_KEY];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function wrapHandler<A, R>(handler: (args: A, extra: unknown) => R | Promise<R>) {
  return async (args: A, extra?: unknown): Promise<R> => {
    // A minted `tlc_` is the fallback, not the default: it keeps the correlation
    // header populated (and the pre-F-1200 behaviour intact) on any runtime that
    // does not stamp the real id.
    const tool_call_id = readSdkToolUseId(extra) ?? generateToolCallId();
    return withCorrelation(tool_call_id, () => Promise.resolve(handler(args, extra)));
  };
}
