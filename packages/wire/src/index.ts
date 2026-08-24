// SPDX-License-Identifier: Apache-2.0
/**
 * wire — the trace surface every Pome process agrees on.
 *
 * Three clusters, and nothing else: the recorder-event union that twins write
 * and the CLI reads (`recorder-events.ts`), the OpenTelemetry-native extension
 * of that union (`otel/`), and the secret redactor applied on the way to disk
 * (`redaction.ts`). Every twin, the sdk, the adapter and the CLI depend on this
 * package; NOTHING ON THIS BARREL knows about sessions, tasks, runs or the
 * cloud REST surface — those live in `cli/src/contract/`.
 *
 * THAT CLAIM WAS NARROWED ONCE, and this is the whole of the narrowing: the
 * package now also ships `@pome-sh/wire/run-completeness`, four symbols that
 * read two fields of a `criteria_results` row (`skipped`, `reason`) and return
 * whether a finished run has a verdict to state. That is the one predicate
 * pome-cloud's dashboard and control plane and this repo's CLI all have to
 * agree on, and until the CLI's agreement test kept a hand-written copy
 * of it that went stale green. It is run-ADJACENT, so the sentence above would
 * be false if it said "this package"; it is not run vocabulary, because it
 * names no session, task, run id, REST route or column, imports nothing, and
 * takes structural inputs so no cloud type crosses with it. Keeping it OFF this
 * barrel is what keeps the sentence above enforceable rather than merely
 * written down — see below.
 *
 * Three SUBPATH-ONLY surfaces are deliberately absent from this barrel.
 * `@pome-sh/wire/otel/fixtures` (the golden-fixture corpus, a test/dev
 * artifact) and `@pome-sh/wire/correlation` (the agent-side
 * AsyncLocalStorage + fetch-patching plumbing that stamps
 * `x-pome-correlation-id`) are absent because only some consumers should pay to
 * LOAD them: importing correlation constructs an AsyncLocalStorage, and no twin
 * is the agent side of that protocol. `@pome-sh/wire/run-completeness`
 * is absent for a different reason — SCOPE, not cost. The five twins, the sdk
 * and the adapter import this barrel and not one of them has a run to ask
 * about, so a symbol they cannot use has no business in their namespace, and an
 * opt-in subpath is what makes the boundary above a thing CI can check.
 * `test/export-surface.test.ts` pins all three: each subpath's own surface, and
 * its absence from the snapshot below.
 *
 * This file is a THIN BARREL: it re-exports only.
 */

export * from "./recorder-events.js";
export * from "./redaction.js";
// OpenTelemetry-native trace surface (M1): OtelSpanEvent schema,
// GenAI/HTTP span mapper, legacy→span shim, pinned semconv, otelEventSchema.
export * from "./otel/index.js";
