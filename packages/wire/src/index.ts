// SPDX-License-Identifier: Apache-2.0
/**
 * wire — the trace surface every Pome process agrees on.
 *
 * Three clusters, and nothing else: the recorder-event union that twins write
 * and the CLI reads (`recorder-events.ts`), the OpenTelemetry-native extension
 * of that union (`otel/`), and the secret redactor applied on the way to disk
 * (`redaction.ts`). Every twin, the sdk, the adapter and the CLI depend on this
 * package; NOTHING here knows about sessions, tasks, runs or the cloud REST
 * surface — those live in `cli/src/contract/` (F-942).
 *
 * Two SUBPATH-ONLY surfaces are deliberately absent from this barrel, because
 * only some consumers should pay to load them: `@pome-sh/wire/otel/fixtures`
 * (the golden-fixture corpus, a test/dev artifact) and
 * `@pome-sh/wire/correlation` (F-950 — the agent-side AsyncLocalStorage +
 * fetch-patching plumbing that stamps `x-pome-correlation-id`; importing it
 * constructs an AsyncLocalStorage, and no twin is the agent side of that
 * protocol). `test/export-surface.test.ts` pins both halves of that call.
 *
 * This file is a THIN BARREL: it re-exports only.
 */

export * from "./recorder-events.js";
export * from "./redaction.js";
// OpenTelemetry-native trace surface (M1 / FDRS-480-482): OtelSpanEvent schema,
// GenAI/HTTP span mapper, legacy→span shim, pinned semconv, otelEventSchema.
export * from "./otel/index.js";
