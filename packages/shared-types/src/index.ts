// SPDX-License-Identifier: Apache-2.0
/**
 * shared-types — public V1 contract barrel.
 *
 * Owns identity/session/task REST contracts plus re-exports for the trace
 * surface in `recorder-events.ts`, completed-run shape in `run.ts`, and the
 * OpenTelemetry extension surface in `otel/`. Release history and migration
 * notes live in CHANGELOG.md.
 *
 * This file is a THIN BARREL (F-754): it re-exports only. The contract clusters
 * live in topical leaf modules — identity/sessions/seed-state/task/rest/
 * finalize-shapes/errors — each re-exported here with identical names so
 * `import { ... } from "@pome-sh/shared-types"` is unchanged.
 */

// Barrel re-exports — consumers `import { ... } from "@pome-sh/shared-types"`
// regardless of which leaf file owns the type.
export * from "./run.js";
export * from "./task-vocab.js";
// F-942 — the trace surface (recorder events, redaction, the OTel extension)
// now lives in @pome-sh/wire. Re-exported here only while the remaining
// cloud-contract clusters are moved to cli/src/contract/; both this line and
// this package go away in the same milestone.
export * from "@pome-sh/wire";

// V1 contract clusters (F-754 split out of this file, zero behavior change):
export * from "./identity.js";          // §1 IDENTITY
export * from "./sessions.js";          // §2 SESSIONS
export * from "./seed-state.js";        // §3 TASKS — provider seed-state schemas
export * from "./seed-envelope.js";     // §3 TASKS — multi-twin seed envelope (M3)
export * from "./task.js";              // §3 TASKS — task config / task / persisted-task
export * from "./rest.js";              // §4 PUBLIC REST API (minus finalize family)
export * from "./finalize-shapes.js";   // §4 PUBLIC REST API — /finalize response family
export * from "./errors.js";            // §5 ERROR ENVELOPE
export * from "./manifest.js";          // §6 MANIFEST — pome.json/pome.yaml + slug authority (F-818)
