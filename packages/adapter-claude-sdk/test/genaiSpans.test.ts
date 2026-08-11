// SPDX-License-Identifier: Apache-2.0
//
// withGenAiSpans → real OTLP/HTTP-JSON export. Stands up a local HTTP sink,
// points the adapter's exporter at it via the pome env contract, drives a
// synthetic SDK message stream, and asserts the captured ExportTraceServiceRequest
// carries gen_ai token attributes + the resource/service identity + auth header.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Captured {
  authorization?: string;
  xApiKey?: string;
  body: unknown;
}

let server: Server;
let port: number;
let captured: Captured[];

const ENV_KEYS = [
  "POME_OTEL_EXPORTER_OTLP_ENDPOINT",
  "POME_OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  captured = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave null */
      }
      captured.push({
        authorization: req.headers["authorization"] as string | undefined,
        xApiKey: req.headers["x-api-key"] as string | undefined,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}/v1/sessions/ses_test/traces`;
  process.env.POME_OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer test-jwt";
  process.env.OTEL_SERVICE_NAME = "pr-sum-agent";
  process.env.OTEL_RESOURCE_ATTRIBUTES = "pome.session_id=ses_test,pome.run_id=run_test";

  const { _resetOtelForTest } = await import("../src/otel.js");
  _resetOtelForTest();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { _resetOtelForTest } = await import("../src/otel.js");
  _resetOtelForTest();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

// Flatten OTLP/JSON `[{ key, value: { stringValue | intValue | ... } }]` into a
// plain record. int64 values arrive as decimal strings in OTLP/JSON.
function flattenAttrs(attrs: Array<{ key: string; value: Record<string, unknown> }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
}

// A message may carry `__sleepMs` to hold the source generator before yielding
// it, so a test can prove which messages move the span-window boundary.
async function drive(messages: Array<{ type: string; [k: string]: unknown }>): Promise<void> {
  const { withGenAiSpans } = await import("../src/genai-spans.js");
  async function* src() {
    for (const m of messages) {
      const sleep = m.__sleepMs as number | undefined;
      if (sleep) await new Promise((r) => setTimeout(r, sleep));
      yield m;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of withGenAiSpans(src())) void _;
}

type ExportedSpan = {
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
};

// Every span the collector received, across all export requests.
function collectSpans(): ExportedSpan[] {
  const spans: ExportedSpan[] = [];
  for (const c of captured) {
    const rs = ((c.body as { resourceSpans?: unknown[] }).resourceSpans ?? []) as Array<Record<string, unknown>>;
    for (const r of rs) {
      for (const ss of (r.scopeSpans ?? []) as Array<{ spans?: unknown[] }>) {
        for (const s of (ss.spans ?? []) as ExportedSpan[]) spans.push(s);
      }
    }
  }
  return spans;
}

function inputTokensOf(span: ExportedSpan): number {
  return Number(flattenAttrs(span.attributes)["gen_ai.usage.input_tokens"]);
}

function outputTokensOf(span: ExportedSpan): number {
  return Number(flattenAttrs(span.attributes)["gen_ai.usage.output_tokens"]);
}

function durationMsOf(span: ExportedSpan): number {
  return (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6;
}

describe("withGenAiSpans → OTLP/JSON export", () => {
  it("emits a gen_ai span per assistant turn with token usage, then flushes on result", async () => {
    await drive([
      { type: "system" },
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    // Auth header from the pome env contract reaches the collector.
    expect(captured[0]!.authorization).toBe("Bearer test-jwt");

    // Collect all spans across all received export requests.
    const spans: Array<{ name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> = [];
    let resourceAttrs: Record<string, unknown> = {};
    for (const c of captured) {
      const rs = (c.body as { resourceSpans?: unknown[] }).resourceSpans ?? [];
      for (const r of rs as Array<Record<string, unknown>>) {
        resourceAttrs = {
          ...resourceAttrs,
          ...flattenAttrs((r.resource as { attributes?: never }).attributes ?? []),
        };
        for (const ss of (r.scopeSpans ?? []) as Array<{ spans?: unknown[] }>) {
          for (const s of (ss.spans ?? []) as never[]) spans.push(s);
        }
      }
    }

    expect(spans.length).toBe(2);
    const a = flattenAttrs(spans[0]!.attributes);
    expect(a["gen_ai.provider.name"]).toBe("anthropic");
    expect(a["gen_ai.operation.name"]).toBe("chat");
    expect(a["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(Number(a["gen_ai.usage.input_tokens"])).toBe(10);
    expect(Number(a["gen_ai.usage.output_tokens"])).toBe(5);
    expect(spans[0]!.name).toBe("chat claude-opus-4-8");

    // Resource identity for dashboard attribution.
    expect(resourceAttrs["service.name"]).toBe("pr-sum-agent");
    expect(resourceAttrs["pome.session_id"]).toBe("ses_test");
  });

  it("forwards the x-api-key header (the production auth path the CLI injects)", async () => {
    process.env.POME_OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=pme_team_key";
    const { _resetOtelForTest } = await import("../src/otel.js");
    _resetOtelForTest();

    await drive([
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    // The CLI ships the team key via `x-api-key`, not `Authorization: Bearer`.
    expect(captured[0]!.xApiKey).toBe("pme_team_key");
  });

  it("skips assistant turns that reported no usage", async () => {
    await drive([
      { type: "assistant", message: { model: "claude-opus-4-8" } },
      { type: "result", subtype: "success" },
    ]);

    const spans: unknown[] = [];
    for (const c of captured) {
      const rs = ((c.body as { resourceSpans?: unknown[] }).resourceSpans ?? []) as Array<Record<string, unknown>>;
      for (const r of rs) {
        for (const ss of (r.scopeSpans ?? []) as Array<{ spans?: unknown[] }>) {
          for (const s of ss.spans ?? []) spans.push(s);
        }
      }
    }
    expect(spans.length).toBe(0);
  });

  it("is inert when no OTLP endpoint is configured", async () => {
    delete process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT;
    const { _resetOtelForTest } = await import("../src/otel.js");
    _resetOtelForTest();

    await drive([
      { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(captured.length).toBe(0);
  });
});

// F-994. Anthropic's `usage.input_tokens` counts only the tokens that missed the
// cache; OTel semconv 1.27+ defines `gen_ai.usage.input_tokens` as the TOTAL.
// The usage objects below are verbatim from a live Opus run (see the probe
// evidence on the ticket) — Claude Code keeps a cache breakpoint at the tail of
// the prompt, so the uncached residue is a constant 2 and the real input sits in
// the two cache fields.
describe("withGenAiSpans → gen_ai.usage.input_tokens is the semconv total", () => {
  it("sums input_tokens + cache_read + cache_creation", async () => {
    await drive([
      {
        type: "assistant",
        message: {
          id: "msg_01",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 2,
            output_tokens: 31,
            cache_read_input_tokens: 15000,
            cache_creation_input_tokens: 3000,
          },
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const spans = collectSpans();
    expect(spans.length).toBe(1);
    expect(inputTokensOf(spans[0]!)).toBe(18002);
    // Output tokens are not a cached quantity — passed through untouched.
    expect(Number(flattenAttrs(spans[0]!.attributes)["gen_ai.usage.output_tokens"])).toBe(31);
  });

  it("treats absent cache components as 0 instead of null-propagating", async () => {
    await drive([
      { type: "assistant", message: { id: "msg_01", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(inputTokensOf(collectSpans()[0]!)).toBe(10);
  });

  it("treats null cache components as 0 (the SDK types them `number | null`)", async () => {
    await drive([
      {
        type: "assistant",
        message: {
          id: "msg_01",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 7,
            output_tokens: 5,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          },
        },
      },
      { type: "result", subtype: "success" },
    ]);

    expect(inputTokensOf(collectSpans()[0]!)).toBe(7);
  });

  // One API turn may arrive as several `assistant` messages sharing a
  // `message.id` (one per content block), each repeating the SAME usage. Once
  // the cache components are summed, counting each block would multiply the
  // cache read by the block count — a live 5-turn run over-reported by 79%.
  it("counts one API turn split across content blocks exactly once", async () => {
    const turnA = { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 36276 };
    const turnB = {
      input_tokens: 2,
      output_tokens: 55,
      cache_read_input_tokens: 36276,
      cache_creation_input_tokens: 250,
    };
    await drive([
      { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", usage: turnA } },
      { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", usage: turnA } },
      { type: "user" },
      { type: "assistant", message: { id: "msg_B", model: "claude-opus-4-8", usage: turnB } },
      { type: "result", subtype: "success" },
    ]);

    const spans = collectSpans();
    expect(spans.length).toBe(2);
    // Matches the SDK's own `SDKResultMessage.usage` rollup for this stream.
    expect(spans.map(inputTokensOf)).toEqual([36278, 36528]);
  });

  it("still emits the final turn when the stream ends without a result message", async () => {
    await drive([
      {
        type: "assistant",
        message: { id: "msg_01", model: "claude-opus-4-8", usage: { input_tokens: 2, cache_read_input_tokens: 900 } },
      },
    ]);
    const { flushPomeTelemetry } = await import("../src/otel.js");
    await flushPomeTelemetry();

    const spans = collectSpans();
    expect(spans.length).toBe(1);
    expect(inputTokensOf(spans[0]!)).toBe(902);
  });
});

// F-998. An `assistant` message's `usage.output_tokens` is the `message_start`
// snapshot — the count at the moment the stream envelope was cut, ~5x low. The
// tell is `stop_reason: null` on every assistant message. The finished number
// exists only on the `message_delta` stream event, which the adapter now gets by
// injecting `includePartialMessages` (see partial-messages.ts).
describe("withGenAiSpans → gen_ai.usage.output_tokens is the message_delta truth", () => {
  const streamStart = (id: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id, usage: { input_tokens: 2, output_tokens: 2 } } },
  });
  const streamDelta = (outputTokens: number, stopReason: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
  });

  // The two numbers the main agent's turn reports in the sub-agent tapes
  // below: its `message_delta` truth, and its ~5x-low `message_start`
  // snapshot. Named so the sub-agent assertions can say "none of the main
  // turn's numbers" without re-spelling literals the fixtures own.
  const MAIN_DELTA = 517;
  const MAIN_SNAPSHOT = 8;

  /**
   * A sub-agent span must carry the SUB-AGENT's own output count.
   *
   * Deliberately does not assert what that count IS. It is the 4-token
   * `message_start` snapshot today — that is F-1014's defect — and becomes the
   * real total once F-1014 reads `system/task_notification`; asserting either
   * would pin a value an open ticket is going to change (F-1375).
   *
   * What is asserted is that the span carries a real count and that no
   * main-turn number leaked into it. The finiteness check is load-bearing
   * rather than ceremony: `outputTokensOf` yields NaN for a span that carries
   * no `gen_ai.usage.output_tokens` attribute at all, and NaN satisfies every
   * `not.toBe` silently, so without it a regression that drops sub-agent usage
   * entirely leaves this whole file green (verified by mutation).
   *
   * Caveat for whoever takes F-1014: this holds under the ticket's approach 1
   * (derive the split, keep `gen_ai.usage.output_tokens`), which the ticket
   * says to try first. Approaches 2 and 3 deliberately stop putting a
   * sub-agent output count on a `gen_ai` span at all — leaving `gen_ai.usage.*`
   * unset, or not emitting these spans. Those change the span's SHAPE, not
   * just this value, so they should rewrite this test rather than find it
   * already permissive: a test still claiming these spans carry sub-agent
   * output tokens would be wrong, not merely outdated.
   */
  function expectSubagentOwnCount(span: ExportedSpan): void {
    const tokens = outputTokensOf(span);
    expect(Number.isFinite(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).not.toBe(MAIN_DELTA);
    expect(tokens).not.toBe(MAIN_SNAPSHOT);
  }

  it("prefers the message_delta count over the snapshot on the assistant message", async () => {
    await drive([
      streamStart("msg_A"),
      { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 2 } } },
      streamDelta(179, "tool_use"),
      { type: "result", subtype: "success" },
    ]);

    expect(outputTokensOf(collectSpans()[0]!)).toBe(179);
  });

  it("falls back to the snapshot when the caller left partial messages off", async () => {
    await drive([
      { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 31 } } },
      { type: "result", subtype: "success" },
    ]);

    expect(outputTokensOf(collectSpans()[0]!)).toBe(31);
  });

  // The whole point of the ticket: per-turn spans must sum to the SDK's own
  // rollup. Tape below is verbatim from a live 4-turn Opus run whose
  // `SDKResultMessage.usage.output_tokens` was 330 — the snapshots sum to 142.
  it("sums to SDKResultMessage.usage.output_tokens across a multi-turn run", async () => {
    const turn = (id: string, snapshot: number, truth: number, stop: string, blocks: number) => [
      streamStart(id),
      ...Array.from({ length: blocks }, () => ({
        type: "assistant",
        message: { id, model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: snapshot } },
      })),
      streamDelta(truth, stop),
    ];

    await drive([
      ...turn("msg_1", 2, 179, "tool_use", 3),
      { type: "user" },
      ...turn("msg_2", 72, 73, "tool_use", 1),
      // The tool_result `user` message can land BEFORE the turn's message_delta
      // (observed live) — it must not close the turn early.
      { type: "user" },
      ...turn("msg_3", 67, 73, "tool_use", 1),
      { type: "user" },
      ...turn("msg_4", 1, 5, "end_turn", 1),
      { type: "result", subtype: "success" },
    ]);

    const spans = collectSpans();
    expect(spans.length).toBe(4);
    expect(spans.map(outputTokensOf)).toEqual([179, 73, 73, 5]);
    expect(spans.reduce((n, s) => n + outputTokensOf(s), 0)).toBe(330);
  });

  // Measured against `claude` 2.1.220: the SDK forwards no subagent stream
  // events (34 on a two-subagent run, 0 with a `parent_tool_use_id`) while
  // subagent `assistant` messages DO arrive. So a subagent turn has no delta and
  // keeps the snapshot, and the main agent's delta must not leak onto it.
  //
  // Consequence worth knowing: `SDKResultMessage.usage` also excludes subagent
  // usage, so the exactness invariant holds over MAIN-AGENT turns. Live
  // two-subagent run: main deltas 517 + 7 == result 524, with the subagent turns'
  // 4 + 4 sitting outside that total on both sides.
  //
  // F-1014: that "4" snapshot is the defect this ticket tracks — a real
  // sub-agent turn doing ~22k tokens of work reports 4, because the SDK never
  // emits a `message_delta` for it and nothing yet reads the real total from
  // `system/task_notification`. Asserting `4` here as the expected span value
  // would pin that defect a second time (F-1375), so this test does NOT
  // assert what the sub-agent spans' token count equals. It asserts every
  // property of that count which survives F-1014 — see
  // `expectSubagentOwnCount`: a real, positive number carrying none of the
  // main turn's numbers, which is the regression this test guards against
  // ("must not leak onto it," above) and stays true whatever the corrected
  // sub-agent number turns out to be (`system/task_notification`'s
  // `total_tokens`, or `total - input`, per the ticket's ordered approach).
  it("keeps the snapshot on a subagent turn and does not leak the main delta onto it", async () => {
    await drive([
      streamStart("msg_main"),
      { type: "assistant", message: { id: "msg_main", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: MAIN_SNAPSHOT } } },
      streamDelta(MAIN_DELTA, "tool_use"),
      // Subagent turns: assistant messages only, no stream events of their own.
      {
        type: "assistant",
        parent_tool_use_id: "toolu_alpha",
        message: { id: "msg_sub_a", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 4 } },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_beta",
        message: { id: "msg_sub_b", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 4 } },
      },
      { type: "result", subtype: "success" },
    ]);

    const spans = collectSpans();
    expect(spans.length).toBe(3);
    // Main-agent turn: unaffected by F-1014, still the exact message_delta count.
    expect(outputTokensOf(spans[0]!)).toBe(MAIN_DELTA);
    // Sub-agent turns keep their own count with nothing from the main turn in
    // it — see `expectSubagentOwnCount` for why the count itself is not pinned.
    expectSubagentOwnCount(spans[1]!);
    expectSubagentOwnCount(spans[2]!);
  });

  // The lanes keep ONE `pending` turn, not one per stream, so a subagent's
  // assistant message closes whatever turn is open. That cannot lose the main
  // agent's delta: the main message must be complete — message_delta, then
  // message_stop — before the tool_use block it ends on can run, and the
  // subagent only exists because that tool ran. This is the exact interleaving
  // from a live two-subagent tape, and it must still total the SDK's 524.
  it("does not lose the main agent's delta to an interleaved subagent turn", async () => {
    const messageStop = () => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_stop" },
    });
    const sub = (id: string, ptu: string) => ({
      type: "assistant",
      parent_tool_use_id: ptu,
      message: { id, model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 4 } },
    });

    await drive([
      streamStart("msg_main1"),
      { type: "assistant", message: { id: "msg_main1", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: MAIN_SNAPSHOT } } },
      { type: "assistant", message: { id: "msg_main1", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: MAIN_SNAPSHOT } } },
      streamDelta(MAIN_DELTA, "tool_use"),
      messageStop(),
      sub("msg_sub_a", "toolu_alpha"),
      sub("msg_sub_b", "toolu_beta"),
      { type: "user" },
      streamStart("msg_main2"),
      { type: "assistant", message: { id: "msg_main2", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 1 } } },
      streamDelta(7, "end_turn"),
      messageStop(),
      { type: "result", subtype: "success" },
    ]);

    const spans = collectSpans();
    expect(spans.length).toBe(4);
    // Main-agent turns, in stream order, survive the interleaved sub-agent
    // turns untouched.
    expect(outputTokensOf(spans[0]!)).toBe(MAIN_DELTA);
    expect(outputTokensOf(spans[3]!)).toBe(7);
    // spans[1] and spans[2] are the interleaved sub-agent turns — see
    // `expectSubagentOwnCount` for why their count is not pinned (that number,
    // currently a 4-token snapshot, is F-1014's defect) and what is checked
    // instead.
    expectSubagentOwnCount(spans[1]!);
    expectSubagentOwnCount(spans[2]!);
    // Main-agent turns ALONE reproduce SDKResultMessage.usage.output_tokens —
    // read off the exported spans, so the interleaved sub-agent turns
    // provably neither joined this total nor stole from it.
    expect(outputTokensOf(spans[0]!) + outputTokensOf(spans[3]!)).toBe(524);
  });

  // The span window is measured from the previously yielded message. Injected
  // partial messages arrive microseconds before the assistant message they
  // describe, so letting them move the boundary would collapse every window to
  // ~0ms and undo F-994's latency fix.
  it("keeps the span window measured from the last real message", async () => {
    await drive([
      { type: "user" },
      // The API round trip: everything below lands once the response starts.
      { type: "stream_event", __sleepMs: 40, parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_A", usage: {} } } },
      { type: "system", subtype: "status", status: "requesting" },
      { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 2 } } },
      streamDelta(179, "end_turn"),
      { type: "result", subtype: "success" },
    ]);

    const spans = collectSpans();
    expect(spans.length).toBe(1);
    expect(durationMsOf(spans[0]!)).toBeGreaterThanOrEqual(30);
  });
});
