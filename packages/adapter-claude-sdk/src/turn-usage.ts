// SPDX-License-Identifier: Apache-2.0
//
// withTurnUsage (F-766) — stream wrapper that emits one `LlmTurnEvent` per
// assistant turn into the signals JSONL (see signals.ts for the single-writer
// contract). It is the JSONL source-of-truth counterpart to the OTLP
// `withGenAiSpans` lane (genai-spans.ts): both use the SAME turn detection —
// one API turn, accumulated by `message.id` (F-994; see that file for why a
// turn is not an `assistant` message) — but this lane keeps the cache-read /
// cache-creation counts and `finish_reasons` as distinct fields where the OTLP
// lane folds the cache counts into one semconv input total, and it never
// reaches the OTLP exporter, so the two lanes stay independent.
//
// The span window is approximated from message timing exactly as genai-spans.ts
// does — start = the moment we began awaiting this turn (the previous yielded
// message), end = now — so `latency_ms` is an estimate and every M1 row is
// stamped `latency_ms_estimated: true` (the SDK surfaces no per-call API
// timing). `turn_index` is 0-based per `query()` stream. `parent_id` and
// `session_id` are null in M1.
//
// No signals path configured (standalone dev, or any run outside the pome CLI
// runner): `writeLlmTurnEvent` is a static noop, so this wrapper just passes
// messages through.

import { newEventId, writeLlmTurnEvent } from "./signals.js";

type WithType = { type?: string };

type AssistantLike = {
  type: "assistant";
  message?: { id?: unknown; model?: unknown; usage?: unknown; stop_reason?: unknown };
};

/** One API turn being accumulated across its content-block messages. */
interface PendingTurn {
  /** `message.id`, or null when the message carried none (then never merged). */
  id: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  stopReason: string | null;
  startTimeMs: number;
  endTimeMs: number;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function* withTurnUsage<T extends WithType>(
  source: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  // Boundary marking the start of the current turn. Initialized when iteration
  // begins; advanced after every yielded message so each turn's latency spans
  // only the gap since the previous message (matches genai-spans.ts).
  let turnStartMs = Date.now();
  // 0-based counter, per this query() stream. Advances only for turns that
  // actually reported usage (a usage-less assistant message is not a turn).
  let turnIndex = 0;
  let pending: PendingTurn | null = null;

  function closeTurn(): void {
    if (!pending) return;
    writeLlmTurnEvent({
      ts: new Date().toISOString(),
      event_id: newEventId(),
      parent_id: null,
      kind: "LlmTurnEvent",
      turn_index: turnIndex,
      model: pending.model,
      input_tokens: pending.inputTokens,
      output_tokens: pending.outputTokens,
      cache_read_input_tokens: pending.cacheReadTokens,
      cache_creation_input_tokens: pending.cacheCreationTokens,
      finish_reasons: pending.stopReason != null ? [pending.stopReason] : null,
      latency_ms: Math.max(0, pending.endTimeMs - pending.startTimeMs),
      latency_ms_estimated: true,
      session_id: null,
    });
    turnIndex += 1;
    pending = null;
  }

  try {
    for await (const msg of source) {
      if (msg.type === "assistant") {
        const a = msg as AssistantLike & WithType;
        const usage = (a.message?.usage ?? {}) as Record<string, unknown>;
        const inputTokens = asNumber(usage.input_tokens);
        const outputTokens = asNumber(usage.output_tokens);
        // Only a turn that reported usage is a real, completed LLM round-trip.
        if (inputTokens != null || outputTokens != null) {
          const id = asString(a.message?.id);
          const stopReason = asString(a.message?.stop_reason);
          if (pending && id != null && pending.id === id) {
            // Another content block of the turn already being accumulated: the
            // usage is a repeat, so only widen the window and take a stop
            // reason if this block is the one that finally carries it.
            pending.endTimeMs = Date.now();
            if (stopReason != null) pending.stopReason = stopReason;
          } else {
            closeTurn();
            pending = {
              id,
              model: asString(a.message?.model),
              inputTokens,
              outputTokens,
              cacheReadTokens: asNumber(usage.cache_read_input_tokens),
              cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
              stopReason,
              startTimeMs: turnStartMs,
              endTimeMs: Date.now(),
            };
          }
        }
      } else if (msg.type === "result") {
        // Land the last turn before the terminal message escapes to the agent's
        // loop — the pome CLI reads the signals file as soon as it returns.
        closeTurn();
      }

      yield msg;
      turnStartMs = Date.now();
    }
  } finally {
    // A stream that ends without a `result` — error, abort, or a consumer that
    // breaks out of its loop — must not swallow the turn still accumulating.
    closeTurn();
  }
}
