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
// does — start = the moment we began awaiting this turn (the message yielded
// before its first content block), end = the turn's last content block — so
// `latency_ms` is an estimate and every M1 row is
// stamped `latency_ms_estimated: true` (the SDK surfaces no per-call API
// timing). `turn_index` is 0-based per `query()` stream. `parent_event_id` and
// `session_id` are null in M1.
//
// `output_tokens` and `finish_reasons` come from the `message_delta` stream
// event rather than the assistant message (F-998; see partial-messages.ts). The
// assistant message's `output_tokens` is a `message_start` snapshot ~5x low, and
// its `stop_reason` is null on every message the SDK emits — which is why this
// lane's `finish_reasons` had always been null in practice.
//
// No signals path configured (standalone dev, or any run outside the pome CLI
// runner): `writeLlmTurnEvent` is a static noop, so this wrapper just passes
// messages through.

import { MessageDeltaTracker, isPartialMessageArtifact } from "./partial-messages.js";
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
  // begins; advanced after every yielded message an agent author would see, so
  // each turn's latency spans only the gap since the previous one of those
  // (matches genai-spans.ts).
  let turnStartMs = Date.now();
  // 0-based counter, per this query() stream. Advances only for turns that
  // actually reported usage (a usage-less assistant message is not a turn).
  let turnIndex = 0;
  let pending: PendingTurn | null = null;
  const deltas = new MessageDeltaTracker();

  function closeTurn(): void {
    if (!pending) return;
    const truth = deltas.take(pending.id);
    const stopReason = truth?.stopReason ?? pending.stopReason;
    writeLlmTurnEvent({
      ts: new Date().toISOString(),
      event_id: newEventId(),
      // A turn is a root within events.jsonl. The run is not an event row —
      // it is the TRACE, so there is no `event_id` for a turn to point at.
      // F-1200's ticket body said "pointing at the run"; the run has no row
      // to point at.
      parent_event_id: null,
      kind: "LlmTurnEvent",
      turn_index: turnIndex,
      model: pending.model,
      input_tokens: pending.inputTokens,
      output_tokens: truth?.outputTokens ?? pending.outputTokens,
      cache_read_input_tokens: pending.cacheReadTokens,
      cache_creation_input_tokens: pending.cacheCreationTokens,
      finish_reasons: stopReason != null ? [stopReason] : null,
      latency_ms: Math.max(0, pending.endTimeMs - pending.startTimeMs),
      latency_ms_estimated: true,
      session_id: null,
    });
    turnIndex += 1;
    pending = null;
  }

  try {
    for await (const msg of source) {
      deltas.observe(msg);

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
      // Pome's injected partial messages must not advance the boundary, or
      // every `latency_ms` collapses to the gap between two stream events
      // (matches genai-spans.ts).
      if (!isPartialMessageArtifact(msg)) turnStartMs = Date.now();
    }
  } finally {
    // A stream that ends without a `result` — error, abort, or a consumer that
    // breaks out of its loop — must not swallow the turn still accumulating.
    closeTurn();
  }
}
