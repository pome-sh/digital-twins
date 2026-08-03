// SPDX-License-Identifier: Apache-2.0
//
// Tests for the unified events.jsonl discriminated-union schema introduced by
// FDRS-398. The legacy single-shape `recorderEventSchema` is tested separately
// in `recorder-events.test.ts`; this file covers the new union, its variants,
// and the `isLegacyEventRow` detector that lets readers tell the two on-disk
// shapes apart during the v1 rollout.
import { describe, expect, it } from "vitest";
import {
  eventSchema,
  hookEventSchema,
  isLegacyEventRow,
  llmCallEventSchema,
  llmTurnEventSchema,
  recorderEventSchema,
  subagentSpawnEventSchema,
  toolResultEventSchema,
  toolUseEventSchema,
  twinHttpEventSchema,
} from "../src/recorder-events.js";

const baseFields = {
  ts: "2026-05-26T12:00:00.000Z",
  event_id: "evt_1",
  parent_id: null as string | null,
};

const legacyTwinHttpFixture = {
  ts: "2026-05-26T12:00:00.000Z",
  run_id: "run_abc",
  twin: "github" as const,
  request_id: "req_123",
  method: "POST",
  path: "/repos/o/r/issues",
  request_body: {},
  status: 201,
  response_body: { id: 1 },
  latency_ms: 42,
  fidelity: "semantic" as const,
  state_mutation: true,
  state_delta: { before: null, after: { id: 1 } },
  step_id: null,
  tool_call_id: null,
  error: null,
};

const twinHttpFixture = {
  ...legacyTwinHttpFixture,
  kind: "TwinHttpEvent" as const,
  event_id: "evt_twin_1",
  parent_id: null,
};

const llmCallBaselineFixture = {
  ...baseFields,
  kind: "LlmCallEvent" as const,
  host: "api.anthropic.com",
  port: 443,
  latency_ms: 215,
  bytes_in: 1024,
  bytes_out: 4096,
  url: null,
  method: null,
  status: null,
  model: null,
  prompt_tokens: null,
  completion_tokens: null,
  cost_usd: null,
};

const llmCallTlsTerminateFixture = {
  ...baseFields,
  event_id: "evt_llm_tls",
  kind: "LlmCallEvent" as const,
  host: "api.anthropic.com",
  port: 443,
  latency_ms: 215,
  bytes_in: 1024,
  bytes_out: 4096,
  url: "https://api.anthropic.com/v1/messages",
  method: "POST",
  status: 200,
  model: "claude-opus-4-7",
  prompt_tokens: 512,
  completion_tokens: 1024,
  cost_usd: 0.0234,
};

const toolUseFixture = {
  ...baseFields,
  event_id: "evt_tu_1",
  kind: "ToolUseEvent" as const,
  tool_use_id: "toolu_01",
  tool_name: "Bash",
  input: { command: "ls" },
};

const toolResultFixture = {
  ...baseFields,
  event_id: "evt_tr_1",
  parent_id: "evt_tu_1",
  kind: "ToolResultEvent" as const,
  tool_use_id: "toolu_01",
  output: "file1\nfile2\n",
  is_error: false,
};

const subagentSpawnFixture = {
  ...baseFields,
  event_id: "evt_sub_1",
  parent_id: "evt_tu_1",
  kind: "SubagentSpawnEvent" as const,
  parent_tool_use_id: "toolu_01",
};

const hookFixture = {
  ...baseFields,
  event_id: "evt_hook_1",
  kind: "HookEvent" as const,
  hook_name: "PreToolUse",
  tool_name: "Bash",
};

const llmTurnFixture = {
  ...baseFields,
  event_id: "evt_turn_1",
  kind: "LlmTurnEvent" as const,
  turn_index: 0,
  model: "claude-opus-4-8",
  input_tokens: 1200,
  output_tokens: 340,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 128,
  finish_reasons: ["end_turn"],
  latency_ms: 2150,
  latency_ms_estimated: true,
  session_id: null,
};

// A turn where the SDK surfaced no cache/model/finish data — every absent
// value is an explicit null (nullable, not optional).
const llmTurnMinimalFixture = {
  ...baseFields,
  event_id: "evt_turn_min",
  kind: "LlmTurnEvent" as const,
  turn_index: 3,
  model: null,
  input_tokens: 10,
  output_tokens: null,
  cache_read_input_tokens: null,
  cache_creation_input_tokens: null,
  finish_reasons: null,
  latency_ms: 0,
  latency_ms_estimated: true,
  session_id: null,
};

describe("twinHttpEventSchema", () => {
  it("parses a full fixture with legacy fields + new discriminator fields", () => {
    const r = twinHttpEventSchema.parse(twinHttpFixture);
    expect(r.kind).toBe("TwinHttpEvent");
    expect(r.event_id).toBe("evt_twin_1");
    expect(r.parent_id).toBeNull();
    expect(r.twin).toBe("github");
    expect(r.tool_call_id).toBeNull();
  });

  it("rejects wrong kind literal", () => {
    expect(() =>
      twinHttpEventSchema.parse({ ...twinHttpFixture, kind: "LlmCallEvent" })
    ).toThrow();
  });

  it("requires event_id", () => {
    const { event_id: _omit, ...rest } = twinHttpFixture;
    expect(() => twinHttpEventSchema.parse(rest)).toThrow();
  });

  // F-1200 relaxed this. Both parent keys are optional at the object schema so
  // the tolerant reader can run at all: `parent_event_id` cannot be required
  // (a shipped 0.13.0 row does not carry it) and `parent_id` cannot be either
  // (a new-vocab row does not carry it). The "writers emit it explicitly"
  // discipline this test used to hold moved to the `lint:parent-vocab` CI gate
  // and to the fixture corpus, which are the places that can actually see a
  // writer. Tolerating here is the same trade `request_headers` documents in
  // recorder-events.ts: this schema is the only gate into the cloud's tape and
  // a row that fails it is dropped SILENTLY.
  it("accepts a row carrying neither parent key, settling parent_event_id to null", () => {
    const { parent_id: _omit, ...rest } = twinHttpFixture;
    expect(twinHttpEventSchema.parse(rest).parent_event_id).toBeUndefined();
    expect(eventSchema.parse(rest).parent_event_id).toBeNull();
  });
});

// F-1200 — `parent_id` meant four different things across five writers, so the
// canonical spelling is now `parent_event_id` ("the spawning row's event_id")
// and the hook writer's raw SDK id moved to `causing_tool_use_id`.
//
// `parent_id` stays in the schema as the pre-F-1200 spelling for the same
// reason `scenario_step_id` does (FDRS-653): every shipped 0.13.0 emitter
// writes it, and this shape is the only gate into the cloud's tape — a row
// that fails to parse is dropped SILENTLY, so a stored recording arriving as
// an empty tape would be far worse than a duplicated key.
describe("parent vocab tolerant reader (F-1200)", () => {
  it("populates parent_event_id from a legacy row that only wrote parent_id", () => {
    const r = eventSchema.parse({ ...twinHttpFixture, parent_id: "evt_tool_1" });
    expect(r.parent_event_id).toBe("evt_tool_1");
  });

  it("preserves the legacy parent_id as-sent (additive normalization)", () => {
    const r = eventSchema.parse({ ...twinHttpFixture, parent_id: "evt_tool_1" });
    // A re-serialized row must still parse under a pre-F-1200 reader.
    expect(r.parent_id).toBe("evt_tool_1");
  });

  it("reads a new-vocab row that only wrote parent_event_id", () => {
    const { parent_id: _omit, ...rest } = twinHttpFixture;
    const r = eventSchema.parse({ ...rest, parent_event_id: "evt_tool_2" });
    expect(r.parent_event_id).toBe("evt_tool_2");
  });

  it("does not overwrite an explicit parent_event_id: null — null marks a root", () => {
    // The two keys disagreeing is not a shape any writer produces, but an
    // explicit null is the documented root-of-chain marker, so the canonical
    // field wins. `== null` semantics would silently re-parent a root.
    const r = eventSchema.parse({
      ...twinHttpFixture,
      parent_event_id: null,
      parent_id: "evt_tool_1",
    });
    expect(r.parent_event_id).toBeNull();
  });

  it("normalizes every kind, not just TwinHttpEvent", () => {
    const r = eventSchema.parse({ ...toolUseFixture, parent_id: "evt_turn_1" });
    expect(r.parent_event_id).toBe("evt_turn_1");
  });

  it("leaves parent_event_id null when neither key names a parent", () => {
    const r = eventSchema.parse({ ...twinHttpFixture, parent_id: null });
    expect(r.parent_event_id).toBeNull();
  });

  // The polysemy this ticket exists to remove bites the tolerant reader too:
  // on a HookEvent the legacy `parent_id` held a raw SDK `tool_use_id`, not a
  // spawning `event_id`. Copying it into `parent_event_id` like every other
  // kind would mint a parent edge pointing at a row that does not exist.
  it("routes a legacy HookEvent parent_id to causing_tool_use_id, not parent_event_id", () => {
    const r = eventSchema.parse({ ...hookFixture, parent_id: "toolu_01WxYzAbCdEf" });
    expect(r.kind).toBe("HookEvent");
    if (r.kind !== "HookEvent") return;
    expect(r.causing_tool_use_id).toBe("toolu_01WxYzAbCdEf");
    expect(r.parent_event_id).toBeNull();
  });

  it("leaves a new-vocab HookEvent's causing_tool_use_id untouched", () => {
    const { parent_id: _omit, ...rest } = hookFixture;
    const r = eventSchema.parse({
      ...rest,
      parent_event_id: null,
      causing_tool_use_id: "toolu_new",
    });
    if (r.kind !== "HookEvent") return;
    expect(r.causing_tool_use_id).toBe("toolu_new");
    expect(r.parent_event_id).toBeNull();
  });

  it("settles a rootless HookEvent's causing_tool_use_id to null, not undefined", () => {
    const r = eventSchema.parse({ ...hookFixture, parent_id: null });
    if (r.kind !== "HookEvent") return;
    expect(r.causing_tool_use_id).toBeNull();
    expect(r.parent_event_id).toBeNull();
  });
});

describe("llmCallEventSchema", () => {
  it("parses baseline-only fixture (TLS-terminate fields all null)", () => {
    const r = llmCallEventSchema.parse(llmCallBaselineFixture);
    expect(r.host).toBe("api.anthropic.com");
    expect(r.port).toBe(443);
    expect(r.bytes_in).toBe(1024);
    expect(r.bytes_out).toBe(4096);
    expect(r.url).toBeNull();
    expect(r.model).toBeNull();
    expect(r.prompt_tokens).toBeNull();
    expect(r.cost_usd).toBeNull();
  });

  it("parses TLS-terminate-mode fixture (all fields populated)", () => {
    const r = llmCallEventSchema.parse(llmCallTlsTerminateFixture);
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.method).toBe("POST");
    expect(r.status).toBe(200);
    expect(r.model).toBe("claude-opus-4-7");
    expect(r.prompt_tokens).toBe(512);
    expect(r.completion_tokens).toBe(1024);
    expect(r.cost_usd).toBeCloseTo(0.0234);
  });

  it("rejects when host is missing", () => {
    const { host: _omit, ...rest } = llmCallBaselineFixture;
    expect(() => llmCallEventSchema.parse(rest)).toThrow();
  });

  it("rejects when port is out of range", () => {
    expect(() =>
      llmCallEventSchema.parse({ ...llmCallBaselineFixture, port: 70000 })
    ).toThrow();
    expect(() =>
      llmCallEventSchema.parse({ ...llmCallBaselineFixture, port: 0 })
    ).toThrow();
  });

  it("rejects negative byte counters", () => {
    expect(() =>
      llmCallEventSchema.parse({ ...llmCallBaselineFixture, bytes_in: -1 })
    ).toThrow();
  });

  it("requires TLS-terminate fields to be present (nullable, not optional)", () => {
    const { model: _omit, ...rest } = llmCallBaselineFixture;
    expect(() => llmCallEventSchema.parse(rest)).toThrow();
  });
});

describe("toolUseEventSchema", () => {
  it("parses a fixture", () => {
    const r = toolUseEventSchema.parse(toolUseFixture);
    expect(r.kind).toBe("ToolUseEvent");
    expect(r.tool_use_id).toBe("toolu_01");
    expect(r.tool_name).toBe("Bash");
  });

  it("requires tool_use_id", () => {
    const { tool_use_id: _omit, ...rest } = toolUseFixture;
    expect(() => toolUseEventSchema.parse(rest)).toThrow();
  });
});

describe("toolResultEventSchema", () => {
  it("parses a successful-result fixture", () => {
    const r = toolResultEventSchema.parse(toolResultFixture);
    expect(r.kind).toBe("ToolResultEvent");
    expect(r.is_error).toBe(false);
    expect(r.tool_use_id).toBe("toolu_01");
  });

  it("parses an error-result fixture", () => {
    const r = toolResultEventSchema.parse({
      ...toolResultFixture,
      is_error: true,
      output: "command not found",
    });
    expect(r.is_error).toBe(true);
  });

  it("requires tool_use_id", () => {
    const { tool_use_id: _omit, ...rest } = toolResultFixture;
    expect(() => toolResultEventSchema.parse(rest)).toThrow();
  });

  it("requires is_error", () => {
    const { is_error: _omit, ...rest } = toolResultFixture;
    expect(() => toolResultEventSchema.parse(rest)).toThrow();
  });
});

describe("subagentSpawnEventSchema", () => {
  it("parses a fixture", () => {
    const r = subagentSpawnEventSchema.parse(subagentSpawnFixture);
    expect(r.kind).toBe("SubagentSpawnEvent");
    expect(r.parent_tool_use_id).toBe("toolu_01");
  });

  it("requires parent_tool_use_id", () => {
    const { parent_tool_use_id: _omit, ...rest } = subagentSpawnFixture;
    expect(() => subagentSpawnEventSchema.parse(rest)).toThrow();
  });
});

describe("hookEventSchema", () => {
  it("parses a fixture with tool_name populated", () => {
    const r = hookEventSchema.parse(hookFixture);
    expect(r.kind).toBe("HookEvent");
    expect(r.hook_name).toBe("PreToolUse");
    expect(r.tool_name).toBe("Bash");
  });

  it("parses a fixture with tool_name null (session/compact hooks)", () => {
    const r = hookEventSchema.parse({
      ...hookFixture,
      hook_name: "SessionStarted",
      tool_name: null,
    });
    expect(r.hook_name).toBe("SessionStarted");
    expect(r.tool_name).toBeNull();
  });

  it("requires hook_name", () => {
    const { hook_name: _omit, ...rest } = hookFixture;
    expect(() => hookEventSchema.parse(rest)).toThrow();
  });

  it("requires tool_name (nullable, not optional)", () => {
    const { tool_name: _omit, ...rest } = hookFixture;
    expect(() => hookEventSchema.parse(rest)).toThrow();
  });
});

describe("llmTurnEventSchema", () => {
  it("parses a full fixture with cache tokens + finish reasons", () => {
    const r = llmTurnEventSchema.parse(llmTurnFixture);
    expect(r.kind).toBe("LlmTurnEvent");
    expect(r.turn_index).toBe(0);
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.input_tokens).toBe(1200);
    expect(r.output_tokens).toBe(340);
    expect(r.cache_read_input_tokens).toBe(900);
    expect(r.cache_creation_input_tokens).toBe(128);
    expect(r.finish_reasons).toEqual(["end_turn"]);
    expect(r.latency_ms).toBe(2150);
    expect(r.latency_ms_estimated).toBe(true);
    expect(r.session_id).toBeNull();
  });

  it("parses a minimal fixture (absent SDK values are explicit null)", () => {
    const r = llmTurnEventSchema.parse(llmTurnMinimalFixture);
    expect(r.model).toBeNull();
    expect(r.output_tokens).toBeNull();
    expect(r.cache_read_input_tokens).toBeNull();
    expect(r.cache_creation_input_tokens).toBeNull();
    expect(r.finish_reasons).toBeNull();
    expect(r.turn_index).toBe(3);
  });

  it("requires turn_index (0-based, non-negative int)", () => {
    const { turn_index: _omit, ...rest } = llmTurnFixture;
    expect(() => llmTurnEventSchema.parse(rest)).toThrow();
    expect(() => llmTurnEventSchema.parse({ ...llmTurnFixture, turn_index: -1 })).toThrow();
    expect(() => llmTurnEventSchema.parse({ ...llmTurnFixture, turn_index: 1.5 })).toThrow();
  });

  it("requires latency_ms_estimated (boolean, not optional)", () => {
    const { latency_ms_estimated: _omit, ...rest } = llmTurnFixture;
    expect(() => llmTurnEventSchema.parse(rest)).toThrow();
  });

  it("treats nullable token/model/finish/session fields as required (nullable, not optional)", () => {
    for (const key of [
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "finish_reasons",
      "session_id",
    ] as const) {
      const { [key]: _omit, ...rest } = llmTurnFixture;
      expect(() => llmTurnEventSchema.parse(rest), `omitting ${key} should throw`).toThrow();
    }
  });
});

describe("eventSchema (discriminated union)", () => {
  it("discriminates each variant by kind", () => {
    expect(eventSchema.parse(twinHttpFixture).kind).toBe("TwinHttpEvent");
    expect(eventSchema.parse(llmCallBaselineFixture).kind).toBe("LlmCallEvent");
    expect(eventSchema.parse(toolUseFixture).kind).toBe("ToolUseEvent");
    expect(eventSchema.parse(toolResultFixture).kind).toBe("ToolResultEvent");
    expect(eventSchema.parse(subagentSpawnFixture).kind).toBe(
      "SubagentSpawnEvent"
    );
    expect(eventSchema.parse(hookFixture).kind).toBe("HookEvent");
    expect(eventSchema.parse(llmTurnFixture).kind).toBe("LlmTurnEvent");
  });

  it("rejects an unknown kind value", () => {
    expect(() =>
      eventSchema.parse({ ...baseFields, kind: "BogusEvent" })
    ).toThrow();
  });

  it("rejects a row missing the kind discriminator", () => {
    const { kind: _omit, ...rest } = hookFixture;
    expect(() => eventSchema.parse(rest)).toThrow();
  });
});

describe("isLegacyEventRow", () => {
  it("returns true for a pre-v1 RecorderEvent row (no kind field)", () => {
    expect(isLegacyEventRow(legacyTwinHttpFixture)).toBe(true);
  });

  it("returns false for each new-shape event", () => {
    expect(isLegacyEventRow(twinHttpFixture)).toBe(false);
    expect(isLegacyEventRow(llmCallBaselineFixture)).toBe(false);
    expect(isLegacyEventRow(toolUseFixture)).toBe(false);
    expect(isLegacyEventRow(toolResultFixture)).toBe(false);
    expect(isLegacyEventRow(subagentSpawnFixture)).toBe(false);
    expect(isLegacyEventRow(hookFixture)).toBe(false);
    expect(isLegacyEventRow(llmTurnFixture)).toBe(false);
  });

  it("returns false for non-object inputs", () => {
    expect(isLegacyEventRow(null)).toBe(false);
    expect(isLegacyEventRow(undefined)).toBe(false);
    expect(isLegacyEventRow(42)).toBe(false);
    expect(isLegacyEventRow("string")).toBe(false);
    expect(isLegacyEventRow([])).toBe(false);
    expect(isLegacyEventRow([{ kind: "TwinHttpEvent" }])).toBe(false);
  });

  it("returns true when kind is present but not a string (treat as legacy)", () => {
    // A row whose `kind` is anything other than a string can't be a new-shape
    // event — readers should route it through the legacy path so the parser
    // surfaces the actual error rather than failing the discriminated union.
    expect(isLegacyEventRow({ kind: 42 })).toBe(true);
    expect(isLegacyEventRow({ kind: null })).toBe(true);
  });

  it("cross-checks against the legacy recorderEventSchema round-trip", () => {
    const parsed = recorderEventSchema.parse(legacyTwinHttpFixture);
    expect(isLegacyEventRow(parsed)).toBe(true);
  });
});
