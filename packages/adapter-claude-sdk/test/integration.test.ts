// SPDX-License-Identifier: Apache-2.0
//
// Full-surface integration: mock @anthropic-ai/claude-agent-sdk, then drive
// the package's public API the way a user would (withPome + tool + query).
// FDRS-407 acceptance: hooks merged into query options emit HookEvent rows;
// tool handlers still set ALS for the x-pome-correlation-id header.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_SCHEMA = {} as never;

let capturedQueryParams: {
  prompt: string;
  options?: { hooks?: unknown; includePartialMessages?: boolean };
} | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => ({ name, description, schema, handler }),
    query: (params: { prompt: string; options?: { hooks?: unknown; includePartialMessages?: boolean } }) => {
      capturedQueryParams = params;
      return fakeQuery();
    },
    // The hooks module imports HOOK_EVENTS from the SDK; mirror the constant
    // here so buildPomeHooks() can iterate over it during tests.
    HOOK_EVENTS: [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "Notification",
      "UserPromptSubmit",
      "UserPromptExpansion",
      "SessionStart",
      "SessionEnd",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "PreCompact",
      "PostCompact",
      "PermissionRequest",
      "PermissionDenied",
      "Setup",
      "TeammateIdle",
      "TaskCreated",
      "TaskCompleted",
      "Elicitation",
      "ElicitationResult",
      "ConfigChange",
      "WorktreeCreate",
      "WorktreeRemove",
      "InstructionsLoaded",
      "CwdChanged",
      "FileChanged",
    ],
  };
});

let fakeMessages: Array<{ type: string }> = [];
// Entries of `fakeMessages` the fake SDK withholds unless the caller asked for
// partial messages. Mirrors the `claude` CLI, where a single gate guards BOTH
// `stream_event` and the per-turn `system/status:requesting` ping:
//   case"stream_request_start": if(H) yield {type:"system",subtype:"status",status:"requesting"}
//   ...                         if(H) yield {type:"stream_event", event:...}
let fakePartialOnly = new Set<{ type: string }>();
async function* fakeQuery() {
  const partial = capturedQueryParams?.options?.includePartialMessages === true;
  for (const m of fakeMessages) {
    if (!partial && fakePartialOnly.has(m)) continue;
    yield m;
  }
}

let tmp: string;
let signalsPath: string;
const ENV_KEYS = [
  "POME_TWIN_BASE_URL",
  "POME_ADAPTER_SIGNALS_PATH",
  "POME_OTEL_EXPORTER_OTLP_ENDPOINT",
  "POME_DISABLE_PARTIAL_MESSAGES",
] as const;
const saved: Record<string, string | undefined> = {};
let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  tmp = mkdtempSync(join(tmpdir(), "pome-int-"));
  signalsPath = join(tmp, "adapter-signals.jsonl");
  process.env.POME_ADAPTER_SIGNALS_PATH = signalsPath;
  process.env.POME_TWIN_BASE_URL = "http://127.0.0.1:3333";

  delete process.env.POME_OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.POME_DISABLE_PARTIAL_MESSAGES;

  fakeMessages = [];
  fakePartialOnly = new Set();
  fetchCalls = [];
  capturedQueryParams = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = (h as Record<string, string>)[k]!;
    fetchCalls.push({ url, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  const { _resetInitForTest } = await import("../src/init.js");
  _resetInitForTest();
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("end-to-end: withPome + tool + query", () => {
  it("query() merges pome hooks for every SDK hook event into the options", async () => {
    const { withPome, query } = await import("../src/index.js");
    withPome();
    fakeMessages = [];
    for await (const _ of query({ prompt: "x" } as Parameters<typeof query>[0])) void _;

    expect(capturedQueryParams).not.toBeNull();
    const hooks = (capturedQueryParams!.options!.hooks ?? {}) as Record<
      string,
      Array<{ hooks: unknown[] }>
    >;
    // Pome installs all 29 hook surfaces.
    expect(Object.keys(hooks).length).toBeGreaterThanOrEqual(29);
    for (const key of Object.keys(hooks)) {
      expect(hooks[key]!.length).toBeGreaterThanOrEqual(1);
      expect(hooks[key]![0]!.hooks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("query() preserves user-supplied hooks alongside pome's", async () => {
    const { withPome, query } = await import("../src/index.js");
    withPome();
    const userHook = vi.fn(async () => ({ continue: true }) as never);
    fakeMessages = [];
    for await (const _ of query({
      prompt: "x",
      options: {
        hooks: {
          PreToolUse: [{ hooks: [userHook] }],
        },
      },
    } as Parameters<typeof query>[0])) void _;

    const merged = (capturedQueryParams!.options!.hooks ?? {}) as Record<
      string,
      Array<{ hooks: unknown[] }>
    >;
    expect(merged.PreToolUse!.length).toBe(2);
  });

  it("tool handler invocation does NOT emit a legacy tool_call signal", async () => {
    const { withPome, tool } = await import("../src/index.js");
    withPome();

    const t = tool(
      "list_open_issues",
      "List open issues",
      FAKE_SCHEMA,
      async () => ({ content: [{ type: "text", text: "[]" }] }),
    );

    await (t as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> }).handler(
      { owner: "acme", repo: "api" },
      {},
    );

    expect(existsSync(signalsPath)).toBe(false);
  });

  it("query() does NOT emit a legacy step signal on assistant messages", async () => {
    const { withPome, query } = await import("../src/index.js");
    withPome();

    fakeMessages = [
      { type: "system" },
      { type: "assistant" },
      { type: "user" },
      { type: "assistant" },
    ];

    const seen: Array<{ type: string }> = [];
    for await (const m of query({ prompt: "x" } as Parameters<typeof query>[0])) seen.push(m);
    expect(seen).toEqual(fakeMessages);

    // No SDK-side hook firings happen in this mocked stream — the merged
    // hooks config is wired through, but the mocked query never invokes any
    // hook callbacks itself. Nothing is written to the signals file.
    expect(existsSync(signalsPath)).toBe(false);
  });

  it("fetch from inside a tool handler still carries x-pome-correlation-id", async () => {
    const { withPome, tool, CORRELATION_HEADER } = await import("../src/index.js");
    withPome();

    const t = tool(
      "do_thing",
      "Calls the twin",
      FAKE_SCHEMA,
      async () => {
        await globalThis.fetch("http://127.0.0.1:3333/v1/repos/acme/api/issues", {
          method: "POST",
          headers: { authorization: "Bearer abc" },
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    await (t as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> }).handler(
      { name: "x" },
      {},
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://127.0.0.1:3333/v1/repos/acme/api/issues");
    expect(fetchCalls[0]!.headers["authorization"]).toBe("Bearer abc");
    expect(fetchCalls[0]!.headers[CORRELATION_HEADER]).toMatch(/^tlc_/);
  });

  it("fetch from outside any tool handler does NOT carry the header", async () => {
    const { withPome } = await import("../src/index.js");
    withPome();

    await globalThis.fetch("http://127.0.0.1:3333/v1/anything");
    expect(fetchCalls[0]!.headers["x-pome-correlation-id"]).toBeUndefined();
  });

  it("acceptance: full M0 row shape — when a hook fires, the row carries kind=HookEvent + event_id + parent_id", async () => {
    const { withPome, query } = await import("../src/index.js");
    withPome();
    fakeMessages = [];
    for await (const _ of query({ prompt: "x" } as Parameters<typeof query>[0])) void _;

    // Pull the pome matcher off the merged hooks config and invoke it as the
    // SDK would on a PreToolUse event.
    const hooks = (capturedQueryParams!.options!.hooks ?? {}) as Record<
      string,
      Array<{ hooks: Array<(i: unknown, t: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>> }>
    >;
    const cb = hooks.PreToolUse![0]!.hooks[0]!;
    await cb(
      {
        hook_event_name: "PreToolUse",
        tool_name: "list",
        tool_input: {},
        tool_use_id: "toolu_42",
      },
      "toolu_42",
      { signal: new AbortController().signal },
    );

    const row = JSON.parse(
      readFileSync(signalsPath, "utf8").trim().split("\n")[0]!,
    );
    expect(row.kind).toBe("HookEvent");
    expect(row.hook_name).toBe("PreToolUse");
    expect(row.tool_name).toBe("list");
    expect(row.parent_id).toBe("toolu_42");
    expect(typeof row.event_id).toBe("string");
    expect(row.event_id.length).toBeGreaterThan(0);
    expect(typeof row.ts).toBe("string");
  });
});

// F-998. The adapter turns `includePartialMessages` on behind the agent
// author's back to reach the only authoritative per-turn output-token count the
// SDK emits (`message_delta`). The price of that is a stream the author never
// asked for, so everything the flag adds is filtered back out before it reaches
// their `for await` loop.
describe("F-998: includePartialMessages injection is invisible to the caller", () => {
  // One API turn as the CLI actually lays it out: the flag-gated artifacts
  // interleaved with the messages an author sees today.
  function buildTape() {
    const statusPing = { type: "system", subtype: "status", status: "requesting" } as { type: string };
    const messageStart = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "msg_A", usage: { input_tokens: 2, output_tokens: 2 } } },
    } as unknown as { type: string };
    const messageDelta = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 179 } },
    } as unknown as { type: string };
    const messageStop = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_stop" },
    } as unknown as { type: string };

    const tape = [
      { type: "system", subtype: "init" } as { type: string },
      statusPing,
      messageStart,
      { type: "assistant", message: { id: "msg_A", model: "m", usage: { input_tokens: 2, output_tokens: 2 } } } as unknown as { type: string },
      messageDelta,
      messageStop,
      { type: "result", subtype: "success" } as { type: string },
    ];
    return { tape, gated: new Set([statusPing, messageStart, messageDelta, messageStop]) };
  }

  async function collect(): Promise<Array<{ type: string }>> {
    const { query } = await import("../src/index.js");
    const seen: Array<{ type: string }> = [];
    for await (const m of query({ prompt: "x" } as Parameters<typeof query>[0])) seen.push(m);
    return seen;
  }

  it("yields byte-identical messages with telemetry on and off", async () => {
    const { tape, gated } = buildTape();
    fakeMessages = tape;
    fakePartialOnly = gated;

    // Telemetry ON (the signals path is set by beforeEach) — the adapter
    // injects, the fake SDK emits the extra messages, the filter removes them.
    const withTelemetry = await collect();
    expect(capturedQueryParams!.options!.includePartialMessages).toBe(true);

    // Telemetry OFF — no injection, so the fake SDK never emits them at all.
    delete process.env.POME_ADAPTER_SIGNALS_PATH;
    const withoutTelemetry = await collect();
    expect(capturedQueryParams!.options!.includePartialMessages).toBeUndefined();

    expect(withTelemetry).toEqual(withoutTelemetry);
    expect(withTelemetry.map((m) => m.type)).toEqual(["system", "assistant", "result"]);
  });

  it("does not request partial messages when no telemetry lane is configured", async () => {
    delete process.env.POME_ADAPTER_SIGNALS_PATH;
    fakeMessages = [{ type: "result", subtype: "success" } as { type: string }];

    await collect();
    expect(capturedQueryParams!.options!.includePartialMessages).toBeUndefined();
  });

  it("honours POME_DISABLE_PARTIAL_MESSAGES as a no-release kill switch", async () => {
    process.env.POME_DISABLE_PARTIAL_MESSAGES = "1";
    fakeMessages = [{ type: "result", subtype: "success" } as { type: string }];

    await collect();
    expect(capturedQueryParams!.options!.includePartialMessages).toBeUndefined();
  });

  it("passes stream events straight through when the caller asked for them", async () => {
    const { tape, gated } = buildTape();
    fakeMessages = tape;
    fakePartialOnly = gated;

    const { query } = await import("../src/index.js");
    const seen: Array<{ type: string }> = [];
    for await (const m of query({
      prompt: "x",
      options: { includePartialMessages: true },
    } as Parameters<typeof query>[0])) {
      seen.push(m);
    }

    // The caller opted in, so nothing is filtered — including the status ping.
    expect(seen).toEqual(tape);
  });
});
