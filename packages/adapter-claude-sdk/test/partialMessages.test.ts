// SPDX-License-Identifier: Apache-2.0
//
// F-998. The `includePartialMessages` plumbing: which messages the flag adds to
// the stream (so they can be filtered back out), when the adapter turns it on,
// and the `message_delta` tracker that carries the only authoritative per-turn
// output-token count the SDK ever emits.
//
// The message shapes below are verbatim from a live Opus run through
// `claude` 2.1.220 — see the tape evidence on the ticket.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISABLE_PARTIAL_MESSAGES_ENV,
  MessageDeltaTracker,
  isPartialMessageArtifact,
  shouldInjectPartialMessages,
} from "../src/partial-messages.js";
import { ADAPTER_SIGNALS_ENV } from "../src/signals.js";
import { OTEL_ENDPOINT_ENV } from "../src/otel.js";

const ENV_KEYS = [DISABLE_PARTIAL_MESSAGES_ENV, ADAPTER_SIGNALS_ENV, OTEL_ENDPOINT_ENV] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("shouldInjectPartialMessages — gated on telemetry actually being on", () => {
  it("stays off when neither telemetry lane is configured", () => {
    expect(shouldInjectPartialMessages()).toBe(false);
  });

  it("turns on for the OTLP span lane", () => {
    process.env[OTEL_ENDPOINT_ENV] = "https://api.pome.sh/v1/sessions/ses_x/traces";
    expect(shouldInjectPartialMessages()).toBe(true);
  });

  it("turns on for the signals JSONL lane alone", () => {
    process.env[ADAPTER_SIGNALS_ENV] = "/tmp/signals.jsonl";
    expect(shouldInjectPartialMessages()).toBe(true);
  });

  it("honours the kill switch so a bad hosted run can be reverted without a release", () => {
    process.env[OTEL_ENDPOINT_ENV] = "https://api.pome.sh/v1/sessions/ses_x/traces";
    process.env[DISABLE_PARTIAL_MESSAGES_ENV] = "1";
    expect(shouldInjectPartialMessages()).toBe(false);
  });
});

// `--include-partial-messages` adds exactly two message kinds. Proven twice: an
// A/B on a deterministic single-turn prompt (0 vs 1 `status:"requesting"` per
// turn, everything else identical), and the `claude` binary itself, where one
// gate variable guards both emissions:
//
//   case"stream_request_start": if(H) yield {type:"system",subtype:"status",status:"requesting"}
//   ...                         if(H) yield {type:"stream_event", event:...}
//
// The sibling `case"sdk_status"` path — `compacting`, the permission-mode
// `status:null`, `compact_result` / `compact_error` — is NOT behind that gate,
// so those reach an agent author with or without pome and must survive the
// filter.
describe("isPartialMessageArtifact — exactly what the flag adds, nothing else", () => {
  it("claims stream_event", () => {
    expect(isPartialMessageArtifact({ type: "stream_event", event: { type: "message_delta" } })).toBe(true);
  });

  it("claims the per-turn status:requesting ping", () => {
    expect(isPartialMessageArtifact({ type: "system", subtype: "status", status: "requesting" })).toBe(true);
  });

  it("leaves compaction status alone — that one flows without the flag", () => {
    expect(isPartialMessageArtifact({ type: "system", subtype: "status", status: "compacting" })).toBe(false);
    expect(
      isPartialMessageArtifact({ type: "system", subtype: "status", status: null, permissionMode: "default" }),
    ).toBe(false);
    expect(
      isPartialMessageArtifact({ type: "system", subtype: "status", status: null, compact_result: "success" }),
    ).toBe(false);
  });

  it("leaves every ordinary message alone", () => {
    for (const msg of [
      { type: "assistant" },
      { type: "user" },
      { type: "result", subtype: "success" },
      { type: "system", subtype: "init" },
      { type: "system", subtype: "thinking_tokens" },
      { type: "rate_limit_event" },
    ]) {
      expect(isPartialMessageArtifact(msg)).toBe(false);
    }
  });
});

describe("MessageDeltaTracker — the authoritative per-turn output tokens", () => {
  function messageStart(id: string, parentToolUseId: string | null = null) {
    return {
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: {
        type: "message_start",
        message: { id, usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 29166 } },
      },
    };
  }

  function messageDelta(outputTokens: number, stopReason: string, parentToolUseId: string | null = null) {
    return {
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens, input_tokens: 2, cache_read_input_tokens: 29166 },
      },
    };
  }

  it("pairs a message_delta with the id from its message_start", () => {
    const t = new MessageDeltaTracker();
    t.observe(messageStart("msg_A"));
    t.observe(messageDelta(179, "tool_use"));

    expect(t.take("msg_A")).toEqual({ outputTokens: 179, stopReason: "tool_use" });
  });

  it("returns null for a turn it never saw a delta for", () => {
    const t = new MessageDeltaTracker();
    t.observe(messageStart("msg_A"));

    expect(t.take("msg_A")).toBeNull();
    expect(t.take(null)).toBeNull();
  });

  it("consumes the entry so a replayed message id cannot double-report", () => {
    const t = new MessageDeltaTracker();
    t.observe(messageStart("msg_A"));
    t.observe(messageDelta(179, "tool_use"));

    expect(t.take("msg_A")?.outputTokens).toBe(179);
    expect(t.take("msg_A")).toBeNull();
  });

  // `BetaMessageDeltaUsage.output_tokens` is documented as CUMULATIVE, and a
  // server-side tool-use loop can emit several message_delta events for one
  // message. The last one is the total, so it overwrites rather than adds.
  it("takes the latest cumulative delta, never the sum", () => {
    const t = new MessageDeltaTracker();
    t.observe(messageStart("msg_A"));
    t.observe(messageDelta(120, "tool_use"));
    t.observe(messageDelta(179, "end_turn"));

    expect(t.take("msg_A")).toEqual({ outputTokens: 179, stopReason: "end_turn" });
  });

  // `message_delta` carries no message id of its own, so the tracker has to
  // remember which message is open. Parallel Task subagents interleave their
  // stream events with the main agent's, and `parent_tool_use_id` is the only
  // thing separating them.
  it("keeps interleaved subagent streams apart by parent_tool_use_id", () => {
    const t = new MessageDeltaTracker();
    t.observe(messageStart("msg_main"));
    t.observe(messageStart("msg_sub", "toolu_01"));
    t.observe(messageDelta(42, "end_turn", "toolu_01"));
    t.observe(messageDelta(179, "tool_use"));

    expect(t.take("msg_sub")).toEqual({ outputTokens: 42, stopReason: "end_turn" });
    expect(t.take("msg_main")).toEqual({ outputTokens: 179, stopReason: "tool_use" });
  });

  // Several deltas can arrive for one message (server-side tool-use loop), so
  // the open slot must survive them and only close on `message_stop`.
  it("keeps the open slot across deltas and releases it on message_stop", () => {
    const messageStop = (parentToolUseId: string | null = null) => ({
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: { type: "message_stop" },
    });

    const t = new MessageDeltaTracker();
    t.observe(messageStart("msg_A"));
    t.observe(messageDelta(120, "tool_use"));
    t.observe(messageDelta(179, "end_turn"));
    t.observe(messageStop());
    // A delta arriving after the stop has no open message to attach to, so it
    // cannot retroactively overwrite the finished turn.
    t.observe(messageDelta(9999, "end_turn"));

    expect(t.take("msg_A")).toEqual({ outputTokens: 179, stopReason: "end_turn" });
  });

  it("ignores a delta that arrives with no message_start ahead of it", () => {
    const t = new MessageDeltaTracker();
    t.observe(messageDelta(179, "tool_use"));

    expect(t.take("msg_A")).toBeNull();
  });

  it("ignores non-stream_event messages and malformed events", () => {
    const t = new MessageDeltaTracker();
    t.observe({ type: "assistant", message: { id: "msg_A", usage: { output_tokens: 2 } } });
    t.observe({ type: "stream_event" });
    t.observe({ type: "stream_event", event: { type: "content_block_delta" } });

    expect(t.take("msg_A")).toBeNull();
  });
});
