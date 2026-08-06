// SPDX-License-Identifier: Apache-2.0
/**
 * correlation — framework-agnostic per-tool-call trace correlation (F-950).
 *
 * The mechanism that lets a twin's `TwinHttpEvent` name the tool call that
 * caused it, with none of the agent framework's vocabulary in it. Extracted from
 * `@pome-sh/adapter-claude-sdk`, where only the `tool()` / `query()` wrapping
 * around it was ever Claude-specific.
 *
 * Three pieces:
 *   • `./context.ts` — the AsyncLocalStorage store (`withCorrelation`,
 *     `currentToolCallId`), which is what makes correlation race-proof across
 *     concurrent tool calls.
 *   • `./fetch.ts`   — the `globalThis.fetch` patch that stamps
 *     `x-pome-correlation-id` on requests to allowlisted twin origins, gated on
 *     that store.
 *   • `./id.ts`      — the fallback id minter, for runtimes that expose no
 *     tool-call id of their own.
 *
 * WHAT AN ADAPTER STILL OWNS. Exactly one thing: where the id comes from and
 * where the scope begins. Sketch, for any framework:
 *
 *     import {
 *       withCorrelation,
 *       generateToolCallId,
 *       installCorrelationFetchHook,
 *     } from "@pome-sh/wire/correlation";
 *
 *     // once, at init
 *     installCorrelationFetchHook({ twinHosts: [...] });
 *
 *     // at each tool invocation the framework dispatches
 *     const id = readFrameworkToolCallId(call) ?? generateToolCallId();
 *     return withCorrelation(id, () => handler(args));
 *
 * `readFrameworkToolCallId` is the only framework-shaped line: the Claude Agent
 * SDK puts it on an MCP `_meta["claudecode/toolUseId"]` key, the Vercel AI SDK
 * exposes `toolCallId` on the tool-call part, LangGraph on the `ToolCall`. None
 * of them needs to re-derive the ALS plumbing or the fetch patch.
 *
 * SUBPATH-ONLY, deliberately NOT on the `@pome-sh/wire` root barrel — the same
 * call as `otel/fixtures`. Importing this module constructs an
 * AsyncLocalStorage and pulls in `node:async_hooks` + `node:crypto`; every twin,
 * the sdk and the CLI import the root barrel, and none of them is the agent side
 * of this protocol. Only a framework adapter should pay for it.
 *
 * This file is a THIN BARREL: it re-exports only.
 */

export { CORRELATION_HEADER } from "./fetch.js";
export {
  getCorrelationAllowlist,
  installCorrelationFetchHook,
  setCorrelationAllowlist,
  uninstallCorrelationFetchHook,
} from "./fetch.js";
export type { CorrelationFetchHookOptions } from "./fetch.js";
export { correlationContext, currentToolCallId, withCorrelation } from "./context.js";
export type { CorrelationContext } from "./context.js";
export { generateToolCallId } from "./id.js";
