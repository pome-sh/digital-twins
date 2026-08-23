// SPDX-License-Identifier: Apache-2.0
//
// withGenAiSpans — stream wrapper that turns the SDK message stream into
// `gen_ai` OTLP spans (see otel.ts for the why and the wire contract).
//
// One CLIENT span per API turn, tagged with the model and that turn's
// input/output tokens. The span window is approximated from message timing —
// start = the moment we began awaiting this turn (the previous yielded
// message), end = the turn's last message — which yields real p50/p95 latency
// samples for the rollup without needing per-call API timings the SDK doesn't
// surface per turn.
//
// A turn is NOT an `assistant` message. One API turn may arrive as several
// `assistant` messages sharing a `message.id`, one per content block (thinking,
// text, tool_use), and every one of them repeats the SAME `usage` object. So we
// accumulate by `message.id` and emit a single span when the turn closes — on
// the next turn, on `result`, or on stream end. Emitting per message would
// multiply the turn's cache-token counts by its content-block count (a
// live 5-turn run over-reported its input total by 79%).
//
// The id check is deliberately against the turn being accumulated rather than
// every id ever seen: a resumed session can legitimately replay a message id,
// and that is a real second turn, not a duplicate block.
//
// Token attribution splits across the two directions. Input is read off the
// assistant message (`totalInputTokens` below). Output is NOT there — the
// assistant message carries a `message_start` snapshot, ~5x low — so it comes
// from the `message_delta` stream event via MessageDeltaTracker, with the
// snapshot kept only as a fallback for a stream that ended before its delta
// (see partial-messages.ts for how those events are obtained and hidden
// again).
//
// On the terminal `result` message we `await flushPomeTelemetry()` BEFORE
// yielding it, so all spans are exported before the agent's loop ends and it
// calls process.exit() — pome's CLI reads the session trace blob immediately
// after the agent returns (the finalize-before-flush contract).

import { flushPomeTelemetry, recordGenAiSpan } from "./otel.js";
import { MessageDeltaTracker, isPartialMessageArtifact } from "./partial-messages.js";

type WithType = { type?: string };

type AssistantLike = {
  type: "assistant";
  message?: { id?: unknown; model?: unknown; usage?: unknown };
  error?: unknown;
};

/** One API turn being accumulated across its content-block messages. */
interface PendingTurn {
  /** `message.id`, or null when the message carried none (then never merged). */
  id: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startTimeMs: number;
  endTimeMs: number;
  isError: boolean;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The OTel-semconv `gen_ai.usage.input_tokens`: the TOTAL input for the turn.
 *
 * Anthropic's `usage.input_tokens` counts only the tokens that missed the
 * cache — the cached prefix is reported separately in `cache_read_input_tokens`
 * and `cache_creation_input_tokens`. Claude Code keeps a cache breakpoint at the
 * tail of the prompt, so on a cached run the raw field is a ~2-token constant
 * and essentially the whole prompt lives in the two cache fields.
 *
 * Each component is read defensively: absent or null contributes 0. Returns
 * null only when the turn reported no input at all, so a usage-less assistant
 * message is still recognised as "not a completed round-trip".
 */
function totalInputTokens(usage: Record<string, unknown>): number | null {
  const uncached = asNumber(usage.input_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheCreation = asNumber(usage.cache_creation_input_tokens);
  if (uncached == null && cacheRead == null && cacheCreation == null) return null;
  return (uncached ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
}

export async function* withGenAiSpans<T extends WithType>(
  source: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  // Boundary marking the start of the next turn. Initialized when iteration
  // begins; advanced after every yielded message an agent author would see, so
  // a turn's span starts at the message yielded before its first content block.
  let turnStartMs = Date.now();
  let pending: PendingTurn | null = null;
  const deltas = new MessageDeltaTracker();

  function closeTurn(): void {
    if (!pending) return;
    const truth = deltas.take(pending.id);
    recordGenAiSpan({
      model: pending.model,
      inputTokens: pending.inputTokens,
      outputTokens: truth?.outputTokens ?? pending.outputTokens,
      startTimeMs: pending.startTimeMs,
      endTimeMs: pending.endTimeMs,
      isError: pending.isError,
    });
    pending = null;
  }

  try {
    for await (const msg of source) {
      deltas.observe(msg);

      if (msg.type === "assistant") {
        const a = msg as AssistantLike & WithType;
        const usage = (a.message?.usage ?? {}) as Record<string, unknown>;
        const inputTokens = totalInputTokens(usage);
        const outputTokens = asNumber(usage.output_tokens);
        // Only a turn that reported usage is a real, completed LLM round-trip.
        if (inputTokens != null || outputTokens != null) {
          const id = typeof a.message?.id === "string" ? a.message.id : null;
          if (pending && id != null && pending.id === id) {
            // Another content block of the turn already being accumulated: the
            // usage is a repeat, so only widen the window and keep any error.
            pending.endTimeMs = Date.now();
            pending.isError ||= a.error != null;
          } else {
            closeTurn();
            pending = {
              id,
              model: typeof a.message?.model === "string" ? a.message.model : null,
              inputTokens,
              outputTokens,
              startTimeMs: turnStartMs,
              endTimeMs: Date.now(),
              isError: a.error != null,
            };
          }
        }
      } else if (msg.type === "result") {
        // Drain the exporter before the final message escapes to the agent's
        // loop, which exits the process right after.
        closeTurn();
        await flushPomeTelemetry();
      }

      yield msg;
      // Partial messages are pome's own injection and land microseconds before
      // the assistant message they describe. Letting them advance the boundary
      // would collapse every span window to ~0ms, so the window stays measured
      // between the messages an agent author would have seen anyway.
      if (!isPartialMessageArtifact(msg)) turnStartMs = Date.now();
    }
  } finally {
    // A stream that ends without a `result` — error, abort, or a consumer that
    // breaks out of its loop — must not swallow the turn still accumulating.
    closeTurn();
  }
}
