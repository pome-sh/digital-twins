// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  KNOWN_TWIN_IDS,
  recorderEventSchema,
  recorderFidelitySchema,
  stateDeltaSchema,
  twinIdSchema,
} from "../src/recorder-events.js";

const baseEvent = {
  ts: "2026-05-11T12:00:00.000Z",
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
  state_delta: { before: null, after: { id: 1, title: "x" } },
  step_id: null,
  tool_call_id: null,
  error: null,
};

describe("twinIdSchema", () => {
  it("accepts canonical 'github'", () => {
    expect(twinIdSchema.parse("github")).toBe("github");
  });
  it("accepts canonical 'stripe'", () => {
    expect(twinIdSchema.parse("stripe")).toBe("stripe");
  });
  it("accepts non-canonical twin id for SDK community-twin compatibility", () => {
    expect(twinIdSchema.parse("linear")).toBe("linear");
  });
  it("rejects empty string", () => {
    expect(() => twinIdSchema.parse("")).toThrow();
  });
});

describe("KNOWN_TWIN_IDS", () => {
  it("contains the V1 canonical first-party twin ids", () => {
    expect(KNOWN_TWIN_IDS).toContain("github");
    expect(KNOWN_TWIN_IDS).toContain("stripe");
    expect(KNOWN_TWIN_IDS).toContain("gmail");
  });
});

describe("recorderFidelitySchema", () => {
  it("accepts 'semantic' and 'unsupported'", () => {
    expect(recorderFidelitySchema.parse("semantic")).toBe("semantic");
    expect(recorderFidelitySchema.parse("unsupported")).toBe("unsupported");
  });
});

describe("stateDeltaSchema", () => {
  it("parses { before, after } with row objects", () => {
    const r = stateDeltaSchema.parse({
      before: { id: 1, title: "old" },
      after: { id: 1, title: "new" },
    });
    expect(r).toEqual({
      before: { id: 1, title: "old" },
      after: { id: 1, title: "new" },
    });
  });

  it("parses null at parent (read-only HTTP call, no mutation)", () => {
    expect(stateDeltaSchema.parse(null)).toBeNull();
  });

  it("parses null `before` (row insert — no prior state)", () => {
    const r = stateDeltaSchema.parse({ before: null, after: { id: 1 } });
    expect(r?.before).toBeNull();
    expect(r?.after).toEqual({ id: 1 });
  });

  it("parses null `after` (row delete — no resulting state)", () => {
    const r = stateDeltaSchema.parse({ before: { id: 1 }, after: null });
    expect(r?.before).toEqual({ id: 1 });
    expect(r?.after).toBeNull();
  });

  it("rejects non-object before/after (e.g. primitive)", () => {
    expect(() => stateDeltaSchema.parse({ before: 42, after: null })).toThrow();
  });
});

describe("recorderEventSchema", () => {
  it("parses a full event with all new fields populated", () => {
    const r = recorderEventSchema.parse({
      ...baseEvent,
      step_id: "stp_1",
      tool_call_id: "tc_42",
    });
    expect(r.step_id).toBe("stp_1");
    expect(r.tool_call_id).toBe("tc_42");
    expect(r.twin).toBe("github");
  });

  it("parses event with stripe twin", () => {
    const r = recorderEventSchema.parse({ ...baseEvent, twin: "stripe" });
    expect(r.twin).toBe("stripe");
  });

  it("accepts non-canonical twin id (SDK community-twin compatibility)", () => {
    const r = recorderEventSchema.parse({ ...baseEvent, twin: "linear" });
    expect(r.twin).toBe("linear");
  });

  it("rejects empty twin string", () => {
    expect(() => recorderEventSchema.parse({ ...baseEvent, twin: "" })).toThrow();
  });

  it("requires step_id (nullable, not optional)", () => {
    const { step_id: _omit, ...rest } = baseEvent;
    expect(() => recorderEventSchema.parse(rest)).toThrow();
  });

  it("requires tool_call_id (nullable, not optional)", () => {
    const { tool_call_id: _omit, ...rest } = baseEvent;
    expect(() => recorderEventSchema.parse(rest)).toThrow();
  });

  it("requires state_delta (nullable, not optional)", () => {
    const { state_delta: _omit, ...rest } = baseEvent;
    expect(() => recorderEventSchema.parse(rest)).toThrow();
  });

  it("preserves existing scenario_step_id (author-time) distinct from step_id (correlator-time)", () => {
    const r = recorderEventSchema.parse({
      ...baseEvent,
      scenario_step_id: "scenario-step-2",
      step_id: "stp_runtime_1",
    });
    expect(r.scenario_step_id).toBe("scenario-step-2");
    expect(r.step_id).toBe("stp_runtime_1");
  });
});

// ── F-1125 ───────────────────────────────────────────────────────────────────
// The two fields that make the S4 class expressible. Both are ADDITIVE and
// optional: `twinHttpEventSchema` is the only gate into the cloud's tape
// (`parseEventsJsonl` silently skips a row that fails it), so a required field
// would drop every row an older CLI wrote — an empty tape, which for a negative
// criterion is a free pass.
describe("recorderEventSchema — F-1125 request_headers", () => {
  it("preserves recorded request headers", () => {
    const r = recorderEventSchema.parse({
      ...baseEvent,
      request_headers: { "x-payment": "eyJ4NDAy", "content-type": "application/json" },
    });
    expect(r.request_headers).toEqual({
      "x-payment": "eyJ4NDAy",
      "content-type": "application/json",
    });
  });

  it("parses a row that carries no request_headers (rows written before F-1125)", () => {
    const r = recorderEventSchema.parse(baseEvent);
    expect(r.request_headers).toBeUndefined();
  });

  it("rejects a non-string header value rather than coercing it", () => {
    expect(() =>
      recorderEventSchema.parse({ ...baseEvent, request_headers: { "content-length": 12 } }),
    ).toThrow();
  });
});

describe("recorderEventSchema — F-1125 tool", () => {
  it("preserves the twin action the call invoked", () => {
    const r = recorderEventSchema.parse({ ...baseEvent, tool: "create_commit_status" });
    expect(r.tool).toBe("create_commit_status");
  });

  it("accepts an explicit null for a call that invoked no declared action", () => {
    const r = recorderEventSchema.parse({ ...baseEvent, tool: null });
    expect(r.tool).toBeNull();
  });

  it("parses a row that carries no tool (rows written before F-1125)", () => {
    const r = recorderEventSchema.parse(baseEvent);
    expect(r.tool).toBeUndefined();
  });

  it("rejects an empty tool name — absent and null already mean 'no action'", () => {
    expect(() => recorderEventSchema.parse({ ...baseEvent, tool: "" })).toThrow();
  });
});
