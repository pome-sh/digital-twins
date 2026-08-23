// SPDX-License-Identifier: Apache-2.0
// Export-surface guard for @pome-sh/wire — the wire half of the former
// `@pome-sh/shared-types` guard.

import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import type {
  Event,
  HookEvent,
  LlmCallEvent,
  LlmTurnEvent,
  OtelEvent,
  OtelSpanEvent,
  RecorderEvent,
  SubagentSpawnEvent,
  ToolResultEvent,
  ToolUseEvent,
  TwinHttpEvent,
} from "../src/index.js";

// Referencing every imported type keeps the guard alive under
// noUnusedLocals-style settings; the tuple is never instantiated.
type _TypeSurfaceAssert = [
  Event,
  HookEvent,
  LlmCallEvent,
  LlmTurnEvent,
  OtelEvent,
  OtelSpanEvent,
  RecorderEvent,
  SubagentSpawnEvent,
  ToolResultEvent,
  ToolUseEvent,
  TwinHttpEvent,
];
// Compile-time anchor: exactly one tuple entry per guarded type. The literal
// type on the left fails to compile if an entry is added or removed above
// without updating the count.
const TYPE_SURFACE_SIZE: _TypeSurfaceAssert["length"] = 11;

// Runtime value exports (types are erased and cannot appear on `Object.keys`).
const EXPECTED_EXPORTS = [
  "ERROR_TYPE",
  "GEN_AI_AGENT_ID",
  "GEN_AI_AGENT_NAME",
  "GEN_AI_OPERATION_NAME",
  "GEN_AI_PROVIDER_NAME",
  "GEN_AI_REQUEST_MODEL",
  "GEN_AI_SYSTEM_DEPRECATED",
  "GEN_AI_TOOL_NAME",
  "GEN_AI_USAGE_COMPLETION_TOKENS_LEGACY",
  "GEN_AI_USAGE_INPUT_TOKENS",
  "GEN_AI_USAGE_OUTPUT_TOKENS",
  "GEN_AI_USAGE_PROMPT_TOKENS_LEGACY",
  "HTTP_REQUEST_METHOD",
  "HTTP_RESPONSE_STATUS_CODE",
  "KNOWN_TWIN_IDS",
  "OPENINFERENCE_LLM_MODEL_NAME",
  "OPENINFERENCE_LLM_PROVIDER",
  "OPENINFERENCE_LLM_SYSTEM",
  "OPENINFERENCE_LLM_TOKEN_COUNT_COMPLETION",
  "OPENINFERENCE_LLM_TOKEN_COUNT_PROMPT",
  "OPENINFERENCE_TOOL_NAME",
  "OTEL_CORE_SEMCONV_VERSION",
  "OTEL_GENAI_SCHEMA_URL",
  "OTEL_GENAI_SCHEMA_VERSION",
  "OTEL_PROJECTION_KEYS",
  "OTEL_SPAN_KINDS",
  "OTEL_STATUS_CODES",
  "SERVER_ADDRESS",
  "SERVER_PORT",
  "UINT64_MAX",
  "URL_FULL",
  "URL_PATH",
  "canonicalSpanIdSchema",
  "canonicalTraceIdSchema",
  "compareUint64",
  "eventSchema",
  "hookEventSchema",
  "isLegacyEventRow",
  "isUint64",
  "llmCallEventSchema",
  "llmTurnEventSchema",
  "mapOtelSpanToEvent",
  "msToNanos",
  "nanosToIso",
  "otelAttributeValueSchema",
  "otelEventSchema",
  "otelSpanEventSchema",
  "otelSpanInputSchema",
  "otelSpanKindSchema",
  "otelStatusCodeSchema",
  "projectAttributes",
  "recorderEventSchema",
  "recorderFidelitySchema",
  "redactEvent",
  "redactSecrets",
  "stateDeltaSchema",
  "subagentSpawnEventSchema",
  "toolResultEventSchema",
  "toolUseEventSchema",
  "twinHttpEventSchema",
  "twinIdSchema",
  "unixNanoSchema",
  "w3cSpanIdSchema",
  "w3cTraceIdSchema",
] as const;

describe("@pome-sh/wire barrel export surface", () => {
  it("re-exports exactly the wire trace surface", () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_EXPORTS]);
  });

  it("guards the TYPE surface (11 event types)", () => {
    // The real guard is the type-only import + _TypeSurfaceAssert tuple above,
    // enforced at typecheck time. This assertion just anchors the count at
    // runtime so the guard's scope is visible in test output.
    expect(TYPE_SURFACE_SIZE).toBe(11);
  });
});

describe("barrel re-export identity (leaf and barrel are the same object)", () => {
  // Zod schemas must be referentially identical across the barrel and the leaf —
  // otherwise discriminated unions and `instanceof` checks downstream silently
  // break. Inherited from the former shared-types `barrel.test.ts`.
  it("re-exports recorderEventSchema, recorderFidelitySchema, twinIdSchema, stateDeltaSchema", async () => {
    const leaf = await import("../src/recorder-events.js");
    expect(api.recorderEventSchema).toBe(leaf.recorderEventSchema);
    expect(api.recorderFidelitySchema).toBe(leaf.recorderFidelitySchema);
    expect(api.twinIdSchema).toBe(leaf.twinIdSchema);
    expect(api.stateDeltaSchema).toBe(leaf.stateDeltaSchema);
  });

  it("re-exports the otel surface from otel/index.ts", async () => {
    const otel = await import("../src/otel/index.js");
    expect(api.otelEventSchema).toBe(otel.otelEventSchema);
    expect(api.otelSpanEventSchema).toBe(otel.otelSpanEventSchema);
    expect(api.mapOtelSpanToEvent).toBe(otel.mapOtelSpanToEvent);
  });

  it("re-exports the redactors from redaction.ts", async () => {
    const redaction = await import("../src/redaction.js");
    expect(api.redactEvent).toBe(redaction.redactEvent);
    expect(api.redactSecrets).toBe(redaction.redactSecrets);
  });
});

// `correlation/` is a SUBPATH-ONLY surface (`@pome-sh/wire/correlation`), the same
// call `otel/fixtures` makes.
describe("@pome-sh/wire/correlation subpath surface", () => {
  const EXPECTED_CORRELATION_EXPORTS = [
    "CORRELATION_HEADER",
    "correlationContext",
    "currentToolCallId",
    "generateToolCallId",
    "getCorrelationAllowlist",
    "installCorrelationFetchHook",
    "setCorrelationAllowlist",
    "uninstallCorrelationFetchHook",
    "withCorrelation",
  ] as const;

  it("exports exactly the framework-agnostic correlation surface", async () => {
    const correlation = await import("../src/correlation/index.js");
    expect(Object.keys(correlation).sort()).toEqual([...EXPECTED_CORRELATION_EXPORTS]);
  });

  it("stays off the root barrel", async () => {
    for (const name of EXPECTED_CORRELATION_EXPORTS) {
      expect(Object.keys(api)).not.toContain(name);
    }
  });

  it("re-exports the same objects as the leaves (one store, one header)", async () => {
    const correlation = await import("../src/correlation/index.js");
    const context = await import("../src/correlation/context.js");
    const fetchHook = await import("../src/correlation/fetch.js");
    expect(correlation.correlationContext).toBe(context.correlationContext);
    expect(correlation.withCorrelation).toBe(context.withCorrelation);
    expect(correlation.CORRELATION_HEADER).toBe(fetchHook.CORRELATION_HEADER);
  });

  it("pins the header name the twins' recorders read back", async () => {
    // Both sides of one wire protocol: the recorders read this exact literal
    // (`packages/sdk/src/recorder.ts`, `mcp-jsonrpc.ts`, the stripe/github
    // twins). A rename here without a rename there breaks correlation silently.
    const { CORRELATION_HEADER } = await import("../src/correlation/index.js");
    expect(CORRELATION_HEADER).toBe("x-pome-correlation-id");
  });
});

// `run-completeness/` is the THIRD subpath-only surface, and the one whose absence
// from the root barrel is load-bearing rather than economical: the barrel's.
describe("@pome-sh/wire/run-completeness subpath surface", () => {
  const EXPECTED_RUN_COMPLETENESS_EXPORTS = [
    "PRE_SATISFIED_REASON",
    "isIncompleteTally",
    "tallyCriteriaResults",
  ] as const;

  it("exports exactly the run-completeness surface", async () => {
    const runCompleteness = await import("../src/run-completeness.js");
    expect(Object.keys(runCompleteness).sort()).toEqual([...EXPECTED_RUN_COMPLETENESS_EXPORTS]);
  });

 it("stays off the root barrel — the claim, checked", async () => {
    for (const name of EXPECTED_RUN_COMPLETENESS_EXPORTS) {
      expect(Object.keys(api)).not.toContain(name);
    }
  });

  it("pins the reason string every surface keys the exemption off", async () => {
    // Both sides of one wire value. pome-cloud's control plane STAMPS this
    // literal on an excluded criterion (`evaluators/deterministic/
    // pre-satisfied.ts`); the dashboard, the markdown report and this repo's
    // CLI all read it back off `criteria_results.reason`. A rename on one side
    // without the other counts every exclusion as an abstention and stamps
    // `Incomplete` on every correctly-scored dedup run.
    const { PRE_SATISFIED_REASON } = await import("../src/run-completeness.js");
    expect(PRE_SATISFIED_REASON).toBe("already_true_in_seed");
  });
});
