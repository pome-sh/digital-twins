// SPDX-License-Identifier: Apache-2.0
//
// OTLP trace export, pointed wherever the caller says.
//
// ── Why this file exists at all ─────────────────────────────────────────────
//
// Run the eval without it and the Braintrust experiment comes back with a row
// of zeros at the bottom of the summary:
//
//   llm_calls 0 · tool_calls 0 · total_tokens 0tok
//
// The agent really did call Anthropic and really did call three tools. But
// Braintrust only sees spans somebody hands it, and nothing here was handing it
// any: `Eval()` traces the task function's INPUT and OUTPUT, not what happened
// inside. So the score columns were right and the trace was empty.
//
// ── The direction that matters ──────────────────────────────────────────────
//
// Pome's own OTLP is INBOUND. On the coach path (`run_task` / `run_trials`) the
// control plane injects `POME_OTEL_EXPORTER_OTLP_ENDPOINT` pointing at Pome's
// own ingest, and `agent-examples/minimal-viktor/src/telemetry.ts` reads exactly
// that. This example is on the REST path (`POST /v1/sandboxes`), which injects
// nothing, and pome-cloud has no outbound exporter — so there is no Pome traffic
// to redirect. What ships the spans is the agent's own exporter, and where they
// land is a URL.
//
// Hence the STANDARD variable names, not the `POME_`-prefixed ones: this reads
// `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`, which is what
// every OpenTelemetry SDK reads and what Braintrust's own docs tell you to set.
// A reader who already exports OTLP somewhere changes one URL.
//
// ── Two properties this file must keep ──────────────────────────────────────
//
// 1. INERT WITHOUT AN ENDPOINT. `scripts/smoke-examples.mjs` launches this
//    example for real on every PR with no credentials, and `gate:examples`
//    typechecks it. Absent `OTEL_EXPORTER_OTLP_ENDPOINT` this returns a no-op
//    with no tracer, nothing is constructed, and no connection is attempted.
// 2. NOTHING READ AT MODULE LOAD. `env` is a parameter. An example that resolved
//    a credential during module evaluation would crash on load under the smoke
//    runner and red CI for everyone — the same rule `src/pome.ts` follows.

import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Env } from "./pome.js";

export const SERVICE_NAME = "pome-braintrust-refund-agent";

export interface Telemetry {
  /** Absent when no endpoint was configured. `experimental_telemetry` stays off. */
  tracer?: Tracer;
  /** Flush and stop. Safe to call when inert. */
  shutdown(): Promise<void>;
}

/**
 * Parse `OTEL_EXPORTER_OTLP_HEADERS` — the W3C-ish `k=v,k=v` form every OTel SDK
 * accepts.
 *
 * Values are split on the FIRST `=` only, which is load-bearing here rather than
 * pedantic: Braintrust's own header is `x-bt-parent=project_id:<id>` and an
 * `Authorization=Bearer <key>` value can carry base64 padding. Splitting on
 * every `=` truncates both, and the failure is a 400 from the collector rather
 * than anything that names the header.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

/**
 * The full traces URL for a configured base endpoint.
 *
 * OTLP's convention is that `OTEL_EXPORTER_OTLP_ENDPOINT` is a BASE and the SDK
 * appends the signal path. `@opentelemetry/exporter-trace-otlp-http` takes a
 * `url` that is the full traces endpoint, so the append happens here.
 *
 * Measured against Braintrust 2026-08-28: `POST https://api.braintrust.dev/otel`
 * answers `404 Cannot POST /otel`, and `.../otel/v1/traces` answers `200 {}`.
 * Both spellings therefore have to work from the same variable, because a reader
 * copying from Braintrust's docs sets the base and a reader copying from an
 * exporter's docs sets the full path.
 */
export function tracesUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

/**
 * Start OTLP export, or return an inert handle.
 *
 * `warn` is injected so the "configured but unusable" case is testable without
 * capturing console output.
 */
export function initTelemetry(
  env: Env,
  warn: (message: string) => void = console.warn,
): Telemetry {
  const inert: Telemetry = { shutdown: async () => {} };
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return inert;

  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);

  // Braintrust REQUIRES `x-bt-parent`, and the failure without it is the kind
  // worth pre-empting rather than diagnosing: measured 2026-08-28, the collector
  // answers `400 No valid spans in this request: 1 rejected, 0 valid`. That
  // message names SPANS, so the obvious reading is a malformed payload — it is a
  // missing header. Warn rather than throw: this is one vendor's requirement and
  // an exporter pointed at any other collector is none of our business.
  if (/braintrust\.dev/i.test(endpoint) && !("x-bt-parent" in lowerKeys(headers))) {
    warn(
      `OTEL_EXPORTER_OTLP_ENDPOINT points at Braintrust but OTEL_EXPORTER_OTLP_HEADERS has no ` +
        `\`x-bt-parent\`. Braintrust will reject every span with "400 No valid spans in this ` +
        `request" — which reads like a bad payload and is not. Add ` +
        `\`x-bt-parent=experiment_id:<id>\` to put the spans in an experiment, or ` +
        `\`project_id:<id>\` / \`project_name:<name>\` to put them in the project's logs.`,
    );
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME?.trim() || SERVICE_NAME,
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl(endpoint), headers })),
    ],
  });

  return {
    tracer: provider.getTracer(SERVICE_NAME),
    // `forceFlush` BEFORE shutdown, and both awaited. A BatchSpanProcessor holds
    // spans until its timer fires, and the eval's last row finishes well inside
    // that window — a process that exits without flushing loses exactly the
    // spans a reader went looking for.
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
