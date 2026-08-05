// SPDX-License-Identifier: Apache-2.0
//
// Export-surface guard for @pome-sh/wire — the wire half of the former
// `@pome-sh/shared-types` guard (F-754, then F-1201). F-942 split that barrel
// three ways; this file keeps the SAME argument for the trace surface, and
// `cli/test/contract/export-surface.test.ts` keeps it for the cloud
// control-plane clusters. Between them they still name every symbol the old
// 145-value / 68-type snapshot named, so the split is auditable as a partition
// rather than as a loosening.
//
// Consumers (the CLI, the sdk, the adapter, all five twins) import runtime
// values by name from this barrel. If a re-export is dropped, renamed, or
// shadowed by an `export *` collision, the sorted key list below drifts and this
// test fails loud.
//
// The type-only import is the TYPE half: `Object.keys` sees runtime values only,
// so a dropped `export type` would pass the runtime snapshot silently. It is
// enforced when `npm run typecheck` compiles this test. Note the scope: it
// catches a kind that DISAPPEARS or is RENAMED. A kind that is ADDED is the
// fixture gate's job (`scripts/emit-trace-contract.mjs`), because no tuple can
// require a payload.

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
  "LEGACY_ATTR_NAMESPACE",
  "LEGACY_ID_PREFIX",
  "LEGACY_SHIM_SEMCONV_VERSION",
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
  "shimLegacyEventToSpan",
  "shimmableLegacyEventSchema",
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

describe("@pome-sh/wire barrel export surface (F-942)", () => {
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
    expect(api.shimLegacyEventToSpan).toBe(otel.shimLegacyEventToSpan);
  });

  it("re-exports the redactors from redaction.ts", async () => {
    const redaction = await import("../src/redaction.js");
    expect(api.redactEvent).toBe(redaction.redactEvent);
    expect(api.redactSecrets).toBe(redaction.redactSecrets);
  });
});
