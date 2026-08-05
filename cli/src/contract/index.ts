// SPDX-License-Identifier: Apache-2.0
/**
 * contract — the /v1 cloud control-plane surface, as this repo declares it.
 *
 * Identity, sessions, task seeds, the completed-run row, the public REST
 * request/response family, the error envelope and the `pome.json` manifest. The
 * CLI is the only thing in this repo that speaks any of it: no twin does, which
 * is why F-942 moved these clusters out of the package all five twins depend on
 * and into `cli/src/`. `pome-cloud` is the counterpart consumer, and CONTRACT.md
 * is the coordination point for a change here.
 *
 * The trace surface (recorder events, redaction, OTel) is NOT here — it is
 * `@pome-sh/wire`, which twins do depend on. `cli/src/types/shared.ts` re-exports
 * both so a CLI module names one import site.
 *
 * This file is a THIN BARREL (F-754): it re-exports only. The clusters live in
 * topical leaf modules, each re-exported here with identical names, so the symbol
 * a consumer imports never depends on which leaf owns it.
 */

export * from "./run.js";               // completed-run row
export * from "./task-vocab.js";        // W3 task/criterion vocabulary + tolerant readers
export * from "./identity.js";          // §1 IDENTITY
export * from "./sessions.js";          // §2 SESSIONS
export * from "./seed-state.js";        // §3 TASKS — provider seed-state schemas
export * from "./seed-envelope.js";     // §3 TASKS — multi-twin seed envelope (M3)
export * from "./task.js";              // §3 TASKS — task config / task / persisted-task
export * from "./rest.js";              // §4 PUBLIC REST API (minus finalize family)
export * from "./finalize-shapes.js";   // §4 PUBLIC REST API — /finalize response family
export * from "./errors.js";            // §5 ERROR ENVELOPE
export * from "./manifest.js";          // §6 MANIFEST — pome.json/pome.yaml + slug authority (F-818)
