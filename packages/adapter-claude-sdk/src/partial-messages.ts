// SPDX-License-Identifier: Apache-2.0
//
// F-998 — everything about `includePartialMessages`: when the adapter turns it
// on behind the caller's back, which messages that adds (so they can be
// filtered back out), and the `message_delta` tracker both telemetry lanes read
// the true per-turn output-token count from.
//
// WHY THE ADAPTER HAS TO ASK FOR THIS
//
// `output_tokens` on an `assistant` message is a `message_start` snapshot — the
// count at the moment the stream envelope was cut, not the finished turn. The
// tell is `stop_reason: null` on every assistant message; a completed Anthropic
// message always has one. Live 4-turn Opus run: the snapshots summed to 142
// against a real 330. The finished value exists only on the `message_delta`
// stream event, and the SDK emits stream events only when `query()` was called
// with `includePartialMessages: true` — the CALLER's option. So the adapter
// sets it itself and hides the consequences (see query.ts).
//
// WHAT THE FLAG ACTUALLY ADDS
//
// Two message kinds, not one. Proven twice: an A/B on a deterministic prompt
// (`system/status` with `status:"requesting"` appeared once per API turn with
// the flag, never without it, two runs each way), and the `claude` binary
// itself, where ONE gate variable guards both emissions:
//
//     case"stream_request_start": if(H) yield {type:"system",subtype:"status",status:"requesting"}
//     ...                         if(H) yield {type:"stream_event", event:...}
//
// The sibling `case"sdk_status"` path — `compacting`, the permission-mode
// `status:null`, `compact_result` / `compact_error` — is NOT behind that gate.
// Those reach an agent author with or without pome, so the filter must let them
// through; dropping every `system/status` would break pass-through fidelity in
// the other direction.
//
// COST, measured on live runs: messages x3.3-3.6, bytes x1.3-1.4. The CLI
// batches content deltas coarsely (a 667-token text turn produced 29 stream
// events, not 667), so this is well short of the order of magnitude the ticket
// budgeted for.

import { OTEL_ENDPOINT_ENV } from "./otel.js";
import { ADAPTER_SIGNALS_ENV } from "./signals.js";

/**
 * Set to `1` / `true` to stop the adapter requesting partial messages, at the
 * cost of `gen_ai.usage.output_tokens` falling back to the ~5x-low snapshot.
 * An escape hatch for a hosted run that misbehaves under the extra stream
 * volume, so it can be reverted by env instead of by release.
 */
export const DISABLE_PARTIAL_MESSAGES_ENV = "POME_DISABLE_PARTIAL_MESSAGES";

type WithType = { type?: unknown };

/**
 * Whether `query()` should request partial messages.
 *
 * Gated on a telemetry lane actually being configured, which mirrors how both
 * lanes are already inert without one: outside the pome CLI runner nothing
 * consumes the extra events, so nothing pays for them.
 */
export function shouldInjectPartialMessages(): boolean {
  const disabled = process.env[DISABLE_PARTIAL_MESSAGES_ENV]?.trim();
  if (disabled === "1" || disabled === "true") return false;
  const otel = process.env[OTEL_ENDPOINT_ENV]?.trim();
  const signals = process.env[ADAPTER_SIGNALS_ENV]?.trim();
  return Boolean(otel) || Boolean(signals);
}

/**
 * True for the messages `includePartialMessages` adds and nothing else — see
 * the gate quoted in the file header. Used both to filter pome's injection back
 * out of the yielded stream and to keep it from moving the turn boundary the
 * telemetry lanes measure latency against.
 */
export function isPartialMessageArtifact(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; subtype?: unknown; status?: unknown };
  if (m.type === "stream_event") return true;
  return m.type === "system" && m.subtype === "status" && m.status === "requesting";
}

/** The per-turn values that exist only on `message_delta`. */
export interface TurnTruth {
  outputTokens: number | null;
  stopReason: string | null;
}

type StreamEventLike = {
  parent_tool_use_id?: unknown;
  event?: {
    type?: string;
    message?: { id?: unknown };
    delta?: { stop_reason?: unknown };
    usage?: { output_tokens?: unknown };
  };
};

/** Bucket key for the main agent's stream; subagents key by tool_use id. */
const MAIN_STREAM = "__main__";

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Collects the authoritative per-turn numbers off `message_delta` and hands
 * them back by `message.id` when a telemetry lane closes that turn.
 *
 * `message_delta` carries no message id of its own, so the id has to come from
 * the `message_start` that opened the message. That makes the "currently open
 * message" a piece of mutable state, and it is bucketed by `parent_tool_use_id`
 * rather than kept as a single global so interleaved streams cannot steal each
 * other's deltas.
 *
 * That bucketing is insurance, not a live code path: measured against `claude`
 * 2.1.220, the SDK forwards **no** subagent stream events at all (34 stream
 * events on a two-subagent run, 0 of them carrying a `parent_tool_use_id`),
 * while subagent `assistant` messages do arrive. So today a subagent turn has no
 * delta to find and keeps the snapshot — see the note on `take()`. The bucket
 * exists because `SDKPartialAssistantMessage` declares `parent_tool_use_id`, so
 * the day the SDK starts forwarding them, parallel Task subagents would
 * otherwise cross-attribute silently.
 *
 * Ordering is safe by construction: `message_delta` always lands before the
 * next turn's `message_start` and before `result`, and a lane only closes a
 * turn on the next turn, on `result`, or at stream end. A turn whose delta never
 * arrived (aborted stream, or any subagent turn) falls back to the snapshot.
 */
export class MessageDeltaTracker {
  readonly #openByStream = new Map<string, string>();
  readonly #truthById = new Map<string, TurnTruth>();

  // `unknown` rather than a message type: this is a defensive reader of a
  // stream whose shape the adapter does not control, and every field below is
  // narrowed before use.
  observe(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as StreamEventLike & WithType;
    if (m.type !== "stream_event") return;
    const ev = m.event;
    if (!ev) return;

    const stream = asString(m.parent_tool_use_id) ?? MAIN_STREAM;

    if (ev.type === "message_start") {
      const id = asString(ev.message?.id);
      if (id) this.#openByStream.set(stream, id);
      else this.#openByStream.delete(stream);
      return;
    }
    // `message_stop` closes the message, so the slot can go. Without this,
    // `#openByStream` would keep one entry per subagent the run ever spawned
    // rather than per stream currently open. Not done on `message_delta`: a
    // server-side tool-use loop can emit several of those for one message, and
    // the later ones still need the id.
    if (ev.type === "message_stop") {
      this.#openByStream.delete(stream);
      return;
    }
    if (ev.type !== "message_delta") return;

    const id = this.#openByStream.get(stream);
    if (!id) return;

    // `BetaMessageDeltaUsage.output_tokens` is CUMULATIVE for the message, and
    // a server-side tool-use loop can emit several deltas for one message — so
    // the latest value replaces the previous one rather than adding to it.
    const prev = this.#truthById.get(id);
    this.#truthById.set(id, {
      outputTokens: asNumber(ev.usage?.output_tokens) ?? prev?.outputTokens ?? null,
      stopReason: asString(ev.delta?.stop_reason) ?? prev?.stopReason ?? null,
    });
  }

  /**
   * Read and forget a turn's true numbers, or null when none were seen — the
   * caller then keeps the snapshot. Null is the normal case for a **subagent**
   * turn, whose stream events the SDK does not forward.
   *
   * Forgetting matters: a resumed session can legitimately replay a
   * `message.id`, and that is a real second turn which must not inherit the
   * first one's totals.
   */
  take(messageId: string | null): TurnTruth | null {
    if (messageId == null) return null;
    const truth = this.#truthById.get(messageId);
    if (!truth) return null;
    this.#truthById.delete(messageId);
    return truth;
  }
}
