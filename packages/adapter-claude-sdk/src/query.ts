// SPDX-License-Identifier: Apache-2.0
import {
  query as sdkQuery,
  type HookCallbackMatcher,
  type HookEvent,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildPomeHooks } from "./hooks.js";
import { withGenAiSpans } from "./genai-spans.js";
import { isPartialMessageArtifact, shouldInjectPartialMessages } from "./partial-messages.js";
import { withTurnUsage } from "./turn-usage.js";
import { withToolEvents } from "./wrapQuery.js";

type QueryParams = Parameters<typeof sdkQuery>[0];
type HooksConfig = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * The positive-evidence marker `scripts/smoke-examples.mjs` classifies
 * REACHED-OUTBOUND on, instead of matching the SDK's failure text. This wrapper
 * sits directly around `sdkQuery()`, the exact call whose internal race between
 * stream-parsing and the child process's 'exit' event picks between two error
 * shapes for the SAME underlying failure (`Claude Code returned an error
 * result: …` vs `Claude Code process exited with code N…`). Printing this,
 * synchronously, before that race can even begin — on the very first pull from
 * the generator, before `sdkQuery()`'s body has done anything — makes the
 * REACHED verdict independent of which shape wins. Gated on
 * `POME_SMOKE_MARK_OUTBOUND` so real users never see it.
 */
export const OUTBOUND_MARKER = "POME_SMOKE_REACHED_OUTBOUND";

/**
 * Drop-in replacement for `@anthropic-ai/claude-agent-sdk`'s `query()`. The
 * returned async iterator yields every SDK message verbatim while attaching
 * pome's read-only `HookEvent` emitter to every SDK hook event
 * and emitting `ToolUseEvent` / `ToolResultEvent` rows for each tool_use /
 * tool_result content block observed in the message stream.
 * User-supplied hooks in `params.options.hooks` are preserved — pome's
 * matchers are prepended per event so they fire alongside user callbacks.
 *
 * ISOLATION, ON BY DEFAULT. Since 0.4.0 this wrapper defaults
 * `options.settingSources` to `[]` — the SDK's documented isolation mode — when
 * the caller does not choose one. `withSealedSettingSources` below carries the
 * measurement behind it, the `tools` posture, and how to opt out.
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
 * gen_ai spans and `LlmTurnEvent` this wrapper emits).
 *
 * Telemetry runs turn on `includePartialMessages` internally: the true
 * per-turn `output_tokens` reaches the SDK only on a `message_delta` stream
 * event. Everything that option adds is filtered back out before it reaches the
 * returned iterator, so the message sequence is exactly what it would have been.
 * Set the option to `true` yourself and pome touches nothing — the stream events
 * flow through as you asked. Setting it to `false` only declines to *see* them:
 * telemetry still asks for them and still filters them out, so the sequence you
 * get is the same either way. `POME_DISABLE_PARTIAL_MESSAGES=1` opts out of
 * asking at all, at the cost of the ~5x-low snapshot.
 *
 * v0: returns an AsyncGenerator, not the full `Query` interface — control
 * methods (`interrupt`, `setPermissionMode`, …) are not re-exposed yet. Use
 * the underlying SDK directly if you need them.
 */
export function query(params: QueryParams): AsyncGenerator<SDKMessage, void, unknown> {
  // A caller who asked for partial messages gets them verbatim; only pome's own
  // injection is hidden again.
  const inject =
    shouldInjectPartialMessages() && params.options?.includePartialMessages !== true;
  const prepared = withSealedSettingSources(withPomeHooks(params, inject));

  // Three read-only stream wrappers, composed innermost-first:
  //   • withToolEvents   — ToolUse/ToolResult/SubagentSpawn rows → signals JSONL
  //   • withTurnUsage    — one LlmTurnEvent per usage-bearing assistant turn
  //                        (incl. cache tokens) → signals JSONL
  //   • withGenAiSpans   — gen_ai OTLP spans for the dashboard telemetry panel;
  //                        flushes the exporter on the terminal `result`.
  // The two signals wrappers append to POME_ADAPTER_SIGNALS_PATH and are inert
  // when it is unset; withGenAiSpans is inert when no OTLP endpoint is set.
  const instrumented = withGenAiSpans<SDKMessage>(
    withTurnUsage<SDKMessage>(withToolEvents<SDKMessage>(sdkQuery(prepared))),
  );

  // Marks the outbound attempt before anything the wrapped stream can
  // throw. Wrapping `instrumented` (rather than `sdkQuery(prepared)` directly)
  // keeps the marker outermost-of-the-instrumentation but still fires on the
  // very first pull, since none of withGenAiSpans/withTurnUsage/withToolEvents
  // do any work before their own first iteration either.
  const marked = withOutboundMarker<SDKMessage>(instrumented);

  // Outermost, so the wrappers above still see the stream events they read the
  // per-turn output tokens from.
  return inject ? withoutPartialMessages(marked) : marked;
}

async function* withOutboundMarker<T>(
  source: AsyncGenerator<T, void, unknown>,
): AsyncGenerator<T, void, unknown> {
  if (process.env.POME_SMOKE_MARK_OUTBOUND === "1") {
    console.error(OUTBOUND_MARKER);
  }
  yield* source;
}

/**
 * Drop the messages `includePartialMessages` added — `stream_event` plus the
 * per-turn `system/status:requesting` ping — so an agent author's `for await`
 * loop sees exactly what it saw before pome started asking for them.
 */
async function* withoutPartialMessages(
  source: AsyncGenerator<SDKMessage, void, unknown>,
): AsyncGenerator<SDKMessage, void, unknown> {
  for await (const msg of source) {
    if (isPartialMessageArtifact(msg)) continue;
    yield msg;
  }
}

/**
 * Defaults `options.settingSources` to `[]` — the SDK's own documented
 * isolation mode: *"When omitted, all sources are loaded (matches CLI
 * defaults). Pass `[]` to disable filesystem settings (SDK isolation mode)."*
 * — unless the caller chose their own.
 *
 * WHY THIS IS A DEFAULT AND NOT A SUGGESTION. Measured 2026-08-05: a
 * `claude-haiku-4-5` trial of the `support-triage` exam, launched from a
 * developer shell with `tools: []` ALREADY SET, called
 * `mcp__plugin_slack_slack__slack_search_channels`, `…__slack_search_public`
 * and `…__slack_list_channel_members`. It searched the developer's REAL Slack
 * workspace, made zero twin calls, and would have scored as "the agent failed
 * to triage" — a verdict about the wrong workspace entirely. Re-run with
 * `settingSources: []` the same trial called only `mcp__github__*` /
 * `mcp__slack__*` and scored 75.
 *
 * `tools` and `settingSources` are DIFFERENT DOORS, and shutting one says
 * nothing about the other. `tools` governs the SDK's built-in base set (`Bash`,
 * `Read`, `Grep`, …); `settingSources` governs FILESYSTEM settings — user
 * (`~/.claude/settings.json`), project (`.claude/settings.json`) and local
 * (`.claude/settings.local.json`) — INCLUDING the Claude Code plugin MCP
 * servers configured on whoever's machine the agent runs on. That is the one
 * surface that changes depending on who runs it, which is what makes it a
 * default rather than an option: an agent is not sealed by everyone remembering.
 *
 * THE `tools` POSTURE: deliberately NOT defaulted. `settingSources: []` removes
 * configuration the HOST supplied and the caller never asked for; `tools: []`
 * would remove the agent's own hands from every consumer of a drop-in wrapper.
 * Only the first is the adapter's to shut. A caller who wants the closed
 * sandbox passes `tools: []` themselves, as every bundled example does.
 *
 * OPTING OUT is by naming what you want, never by omission — omission is what
 * shipped the defect above:
 *
 * ```ts
 * query({ prompt, options: { settingSources: ["user", "project", "local"] } })
 * ```
 *
 * That restores the pre-0.4.0 behaviour exactly. `["project"]` is the narrower
 * choice worth knowing about: the SDK loads `CLAUDE.md` only when `'project'`
 * is among the sources, so an agent that needs its repo's instructions asks for
 * that source rather than dropping the seal.
 *
 * The test is `=== undefined`, matching the SDK's own branch
 * (`if (settingSources !== undefined) push('--setting-sources=' + …)`), so
 * `{ settingSources: undefined }` and an omitted key are treated as the same
 * request. Sealing only one of the two spellings would make isolation depend on
 * how a caller wrote "I didn't choose".
 */
function withSealedSettingSources(params: QueryParams): QueryParams {
  if (params.options?.settingSources !== undefined) return params;
  return { ...params, options: { ...(params.options ?? {}), settingSources: [] } };
}

function withPomeHooks(params: QueryParams, includePartialMessages: boolean): QueryParams {
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
    options: {
      ...(params.options ?? {}),
      hooks: merged,
      ...(includePartialMessages ? { includePartialMessages: true } : {}),
    },
  };
}
