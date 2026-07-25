// SPDX-License-Identifier: Apache-2.0
import {
  query as sdkQuery,
  type HookCallbackMatcher,
  type HookEvent,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildPomeHooks } from "./hooks.js";
import { withGenAiSpans } from "./genai-spans.js";
import { withTurnUsage } from "./turn-usage.js";
import { withToolEvents } from "./wrapQuery.js";

type QueryParams = Parameters<typeof sdkQuery>[0];
type HooksConfig = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * Drop-in replacement for `@anthropic-ai/claude-agent-sdk`'s `query()`. The
 * returned async iterator yields every SDK message verbatim while attaching
 * pome's read-only `HookEvent` emitter to every SDK hook event (FDRS-407)
 * and emitting `ToolUseEvent` / `ToolResultEvent` rows for each tool_use /
 * tool_result content block observed in the message stream (FDRS-408).
 * User-supplied hooks in `params.options.hooks` are preserved — pome's
 * matchers are prepended per event so they fire alongside user callbacks.
 *
 * Pinning the model: pass `params.options.model` (an alias like `"haiku"` /
 * `"sonnet"` / `"opus"`, or a full id like `"claude-haiku-4-5"`). This wrapper
 * forwards it verbatim to the upstream SDK, which passes it to the `claude` CLI
 * as `--model`; omit it to run the CLI's default model. Note the wrapper only
 * forwards the request — it cannot force the runtime to honor it. A
 * subscription/OAuth login or an environment/gateway model pin can still
 * override the choice, and the CLI does not error on an unknown id (it silently
 * falls back). To see the model that actually ran, read `model` off the SDK's
 * `system`/`init` message, or the per-turn `message.model` (both flow into the
 * gen_ai spans and `LlmTurnEvent` this wrapper emits). See F-928.
 *
 * v0: returns an AsyncGenerator, not the full `Query` interface — control
 * methods (`interrupt`, `setPermissionMode`, …) are not re-exposed yet. Use
 * the underlying SDK directly if you need them.
 */
export function query(params: QueryParams): AsyncGenerator<SDKMessage, void, unknown> {
  // Three read-only stream wrappers, composed innermost-first:
  //   • withToolEvents   — ToolUse/ToolResult/SubagentSpawn rows → signals JSONL
  //   • withTurnUsage    — one LlmTurnEvent per usage-bearing assistant turn
  //                        (incl. cache tokens) → signals JSONL (F-766)
  //   • withGenAiSpans   — gen_ai OTLP spans for the dashboard telemetry panel;
  //                        flushes the exporter on the terminal `result`.
  // The two signals wrappers append to POME_ADAPTER_SIGNALS_PATH and are inert
  // when it is unset; withGenAiSpans is inert when no OTLP endpoint is set.
  return withGenAiSpans<SDKMessage>(
    withTurnUsage<SDKMessage>(withToolEvents<SDKMessage>(sdkQuery(withPomeHooks(params)))),
  );
}

function withPomeHooks(params: QueryParams): QueryParams {
  const pomeHooks = buildPomeHooks();
  const userHooks = (params.options?.hooks ?? {}) as HooksConfig;
  const merged: HooksConfig = {};
  for (const key of Object.keys(pomeHooks) as HookEvent[]) {
    merged[key] = [...(pomeHooks[key] ?? []), ...(userHooks[key] ?? [])];
  }
  for (const key of Object.keys(userHooks) as HookEvent[]) {
    if (!merged[key]) merged[key] = [...(userHooks[key] ?? [])];
  }
  return {
    ...params,
    options: { ...(params.options ?? {}), hooks: merged },
  };
}
