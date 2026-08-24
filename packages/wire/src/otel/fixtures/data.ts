// SPDX-License-Identifier: Apache-2.0
/**
 * otel/fixtures/data — frozen golden-fixture corpus (M1.3).
 *
 * The single source of truth for trace fixtures across M2–M6. Static
 * data, deterministic by construction, and DEEP-FROZEN on export (review
 * finding #6 — exported fixtures were runtime-mutable shared state). Three
 * families:
 *
 *   - EMITTER_FIXTURES     — real-emitter spans (Traceloop / Vercel AI SDK /
 *                            Pydantic Logfire), normalized to `OtelSpanInput`
 *                            with provenance + version metadata. M1.1 parses them.
 *   - TRACE_FIXTURES       — multi-span sub-agent traces (parent_span_id trees).
 *   - EXTERNAL_API_FIXTURES — twin-relevant external-API (HTTP) spans (M4 drift).
 *
 * PROVENANCE NOTE (honest sourcing — `derivedFrom: "documentation-derived"`):
 * the emitter fixtures are NORMALIZED `OtelSpanInput` records whose ATTRIBUTE
 * KEYS are taken verbatim from each emitter's published span output (URLs +
 * `sourceVersion` below); attribute VALUES are representative. They are derived
 * from the emitters' documented conventions, NOT captured from a live export —
 * raw OTLP-envelope capture + the AnyValue decoder are M2's scope. Each fixture
 * records its source so M2 can swap in a live capture without changing keys.
 */

import type { OtelSpanInput } from "../map-span.js";

// How a fixture's attribute shape was sourced. Kept explicit so consumers never
// mistake a documentation-derived example for a live capture.
//
// `"live-capture"` (ported from pome-cloud) is reserved for shapes
// captured from a REAL emitter run (creds + network egress required — the
// capture tooling itself is cloud-owned, ). It is part of the
// union so a future capture can set it without a type change; NO fixture in
// this file uses it today — everything here is honestly
// `"documentation-derived"`.
export type FixtureDerivedFrom =
  | "documentation-derived"
  | "pome-internal"
  | "otel-spec"
  | "live-capture";

export interface EmitterFixture {
  name: string;
  emitter: "traceloop" | "vercel-ai-sdk" | "pydantic-logfire";
  provenance: string;
  // The emitter / spec build the attribute keys were taken from. Honest about
  // being a documented shape, not a captured envelope.
  sourceVersion: string;
  derivedFrom: FixtureDerivedFrom;
  span: OtelSpanInput;
}

export interface TraceFixture {
  name: string;
  provenance: string;
  derivedFrom: FixtureDerivedFrom;
  spans: OtelSpanInput[];
}

export interface ExternalApiFixture {
  name: string;
  provenance: string;
  derivedFrom: FixtureDerivedFrom;
  span: OtelSpanInput;
}

// Recursively freeze a fixture tree so a consumer can never mutate the shared
// corpus (review #6). Returns the same reference, now immutable.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ─── Real-emitter spans (normalized OtelSpanInput; keys from each emitter) ────
// Successful spans are left status-UNSET (the OTel convention — `OK` is not set
// merely because a span succeeded). `derivedFrom` flags the documented sourcing.

export const EMITTER_FIXTURES: readonly EmitterFixture[] = deepFreeze<readonly EmitterFixture[]>([
  {
    name: "traceloop/openai-chat",
    emitter: "traceloop",
    // Traceloop / OpenLLMetry emits the deprecated gen_ai.system + pre-1.27
    // prompt_tokens/completion_tokens — exercises both ingestion aliases.
    provenance:
      "https://github.com/traceloop/openllmetry semconv_ai constants + https://www.traceloop.com/docs/openllmetry/contributing/semantic-conventions",
    sourceVersion: "OpenLLMetry semconv_ai (documentation-derived; not a live capture)",
    derivedFrom: "documentation-derived",
    span: {
      trace_id: "11111111111111111111111111111111",
      span_id: "1111111111111111",
      name: "openai.chat",
      kind: "CLIENT",
      start_time_unix_nano: "1780401600000000000",
      end_time_unix_nano: "1780401600500000000",
      attributes: {
        "gen_ai.system": "openai",
        "llm.request.type": "chat",
        "gen_ai.request.model": "gpt-4",
        "gen_ai.response.model": "gpt-4-0613",
        "gen_ai.usage.prompt_tokens": 100,
        "gen_ai.usage.completion_tokens": 180,
        "llm.usage.total_tokens": 280,
        "traceloop.span.kind": "workflow",
        "traceloop.entity.name": "openai.chat",
      },
    },
  },
  {
    name: "vercel-ai-sdk/do-generate",
    emitter: "vercel-ai-sdk",
    // The provider (doGenerate) span carries gen_ai.* with the new
    // input_tokens/output_tokens names; older builds still set gen_ai.system.
    provenance: "https://ai-sdk.dev/docs/ai-sdk-core/telemetry",
    sourceVersion: "Vercel AI SDK telemetry docs (documentation-derived; not a live capture)",
    derivedFrom: "documentation-derived",
    span: {
      trace_id: "22222222222222222222222222222222",
      span_id: "2222222222222222",
      parent_span_id: "2222222222222200",
      name: "ai.generateText.doGenerate",
      kind: "CLIENT",
      start_time_unix_nano: "1780401601000000000",
      end_time_unix_nano: "1780401601900000000",
      attributes: {
        "operation.name": "ai.generateText.doGenerate",
        "ai.operationId": "ai.generateText.doGenerate",
        "ai.response.model": "gpt-4-0613",
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-4",
        "gen_ai.request.temperature": 0.7,
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 180,
      },
    },
  },
  {
    name: "pydantic-logfire/chat",
    emitter: "pydantic-logfire",
    // Pydantic Logfire / Pydantic AI is on the canonical gen_ai.provider.name
    // + input/output names and sets gen_ai.operation.name; span name "chat {model}".
    provenance:
      "https://pydantic.dev/docs/ai/integrations/logfire/ + https://pydantic.dev/docs/ai/api/models/instrumented/",
    sourceVersion: "Pydantic AI / Logfire instrumentation docs (documentation-derived; not a live capture)",
    derivedFrom: "documentation-derived",
    span: {
      trace_id: "33333333333333333333333333333333",
      span_id: "3333333333333333",
      name: "chat gpt-4",
      kind: "CLIENT",
      start_time_unix_nano: "1780401602000000000",
      end_time_unix_nano: "1780401602750000000",
      attributes: {
        "gen_ai.provider.name": "openai",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-4",
        "gen_ai.response.model": "gpt-4",
        "gen_ai.usage.input_tokens": 150,
        "gen_ai.usage.output_tokens": 75,
      },
    },
  },
]);

// ─── Multi-span sub-agent traces ─────────────────────────────────────────────

export const TRACE_FIXTURES: readonly TraceFixture[] = deepFreeze<readonly TraceFixture[]>([
  {
    name: "subagent-fanout/two-children",
    provenance:
      "Pydantic AI invoke_agent + child model spans (https://pydantic.dev/docs/ai/integrations/logfire/). Root agent span fans out to two sub-agent spans, each with one LLM child.",
    derivedFrom: "documentation-derived",
    spans: [
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000000",
        name: "invoke_agent orchestrator",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401600000000000",
        end_time_unix_nano: "1780401603000000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "orchestrator",
          "gen_ai.agent.id": "agent_root",
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000001",
        parent_span_id: "a000000000000000",
        name: "invoke_agent researcher",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401600100000000",
        end_time_unix_nano: "1780401601500000000",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "researcher",
          "gen_ai.agent.id": "agent_research",
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000002",
        parent_span_id: "a000000000000001",
        name: "chat gpt-4",
        kind: "CLIENT",
        start_time_unix_nano: "1780401600200000000",
        end_time_unix_nano: "1780401601400000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4",
          "gen_ai.usage.input_tokens": 200,
          "gen_ai.usage.output_tokens": 90,
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000003",
        parent_span_id: "a000000000000000",
        name: "invoke_agent writer",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401601600000000",
        end_time_unix_nano: "1780401602900000000",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "writer",
          "gen_ai.agent.id": "agent_writer",
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000004",
        parent_span_id: "a000000000000003",
        name: "chat gpt-4",
        kind: "CLIENT",
        start_time_unix_nano: "1780401601700000000",
        end_time_unix_nano: "1780401602800000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4",
          "gen_ai.usage.input_tokens": 140,
          "gen_ai.usage.output_tokens": 60,
        },
      },
    ],
  },
  {
    name: "tool-chain/llm-then-tool",
    provenance:
      "OTel GenAI tool spans (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). One LLM span followed by an execute_tool child.",
    derivedFrom: "otel-spec",
    spans: [
      {
        trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        span_id: "b000000000000000",
        name: "chat gpt-4",
        kind: "CLIENT",
        start_time_unix_nano: "1780401600000000000",
        end_time_unix_nano: "1780401601000000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4",
          "gen_ai.usage.input_tokens": 80,
          "gen_ai.usage.output_tokens": 40,
        },
      },
      {
        trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        span_id: "b000000000000001",
        parent_span_id: "b000000000000000",
        name: "execute_tool create_issue",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401601000000000",
        end_time_unix_nano: "1780401601200000000",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "create_issue",
        },
      },
    ],
  },
]);

// ─── External-API (twin-relevant) spans ──────────────────────────────────────

export const EXTERNAL_API_FIXTURES: readonly ExternalApiFixture[] = deepFreeze<readonly ExternalApiFixture[]>([
  {
    name: "github/get-issue-404",
    provenance:
      "OTel HTTP client semconv (https://opentelemetry.io/docs/specs/semconv/http/http-spans/). A twin-relevant external-API span for M4 drift detection — a 404 from the real GitHub API. Low-cardinality span name (method only).",
    derivedFrom: "otel-spec",
    span: {
      trace_id: "cccccccccccccccccccccccccccccccc",
      span_id: "c000000000000000",
      name: "GET",
      kind: "CLIENT",
      start_time_unix_nano: "1780401600000000000",
      end_time_unix_nano: "1780401600090000000",
      status: { code: "ERROR", message: "Not Found" },
      attributes: {
        "http.request.method": "GET",
        "http.response.status_code": 404,
        "url.full": "https://api.github.com/repos/acme/app/issues/999",
        "url.path": "/repos/acme/app/issues/999",
        "server.address": "api.github.com",
        "server.port": 443,
        "error.type": "404",
      },
    },
  },
]);
