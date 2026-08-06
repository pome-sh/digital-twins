# `@pome-sh/shared-types` dissolution — the completed partition (F-942)

`@pome-sh/shared-types` no longer exists. This file is the audit record of where
each of its modules went and how the split is enforced. It replaces the generated
export×consumer inventory that planned the split
(`scripts/shared-types-inventory.mjs`, deleted in the same commit — it scanned a
directory that is gone, so re-running it produced an empty table).

The generated inventory, with per-symbol consumer lists, is recoverable at
`f568bcf~1:docs/shared-types-inventory.md`.

## Where each module went

| module | exports | destination |
| --- | --- | --- |
| `recorder-events.ts` | 27 | `packages/wire/src/recorder-events.ts` |
| `redaction.ts` | 2 | `packages/wire/src/redaction.ts` |
| `otel/event-schema.ts` | 2 | `packages/wire/src/otel/event-schema.ts` |
| `otel/index.ts` | barrel | `packages/wire/src/otel/index.ts` |
| `otel/legacy-shim.ts` | 7 | `packages/wire/src/otel/legacy-shim.ts` |
| `otel/map-span.ts` | 3 | `packages/wire/src/otel/map-span.ts` |
| `otel/nano.ts` | 5 | `packages/wire/src/otel/nano.ts` |
| `otel/project.ts` | 6 | `packages/wire/src/otel/project.ts` |
| `otel/semconv.ts` | 29 | `packages/wire/src/otel/semconv.ts` |
| `otel/span-event.ts` | 13 | `packages/wire/src/otel/span-event.ts` |
| `otel/fixtures/data.ts` | 11 | `packages/wire/src/otel/fixtures/data.ts` |
| `otel/fixtures/index.ts` | barrel | `packages/wire/src/otel/fixtures/index.ts` |
| `github-access-control.ts` | 15 | merged into `packages/twin-github/src/access-control.ts` |
| `identity.ts` | 16 | `cli/src/contract/identity.ts` |
| `sessions.ts` | 7 | `cli/src/contract/sessions.ts` |
| `seed-state.ts` | 13 | `cli/src/contract/seed-state.ts` |
| `seed-envelope.ts` | 3 | `cli/src/contract/seed-envelope.ts` |
| `task.ts` | 12 | `cli/src/contract/task.ts` |
| `task-vocab.ts` | 3 | `cli/src/contract/task-vocab.ts` |
| `rest.ts` | 35 | `cli/src/contract/rest.ts` |
| `run.ts` | 21 | `cli/src/contract/run.ts` |
| `finalize-shapes.ts` | 22 | `cli/src/contract/finalize-shapes.ts` |
| `errors.ts` | 4 | `cli/src/contract/errors.ts` |
| `manifest.ts` | 10 | `cli/src/contract/manifest.ts` |
| `index.ts` | barrel | split into `packages/wire/src/index.ts` + `cli/src/contract/index.ts` |

`errors.ts` was planned as "DELETED (cloud-only)" and moved instead: nothing in
this repo imports it, but dropping four names from a surface `pome-cloud` reads
is a cross-repo decision, not a side effect of a file move.

## The line the split follows

- **`@pome-sh/wire`** — the trace surface. Every twin, the sdk, the adapter and
  the CLI depend on it. It knows nothing about sessions, tasks, runs or REST.
- **`cli/src/contract/`** — the `/v1` cloud control plane. The CLI and
  `pome-cloud` are the only consumers; **no twin imports any of it**, which is why
  a change here must not rebuild five twin images
  (`.github/workflows/twin-image.yml` filters on `packages/wire/**` and
  deliberately not on `cli/src/contract/**`).
- **`packages/twin-github/src/access-control.ts`** — GitHub-specific endpoint
  data, now beside the tool-table fixture that is the only thing able to
  contradict it. Its catalog check reads `githubToolFixture.toolNames`, the
  listing the twin actually serves (F-1325).

## How the partition is enforced

The old barrel's frozen surface guard (145 runtime values, 68 types) is now three
guards whose union is that surface, so a symbol cannot go missing in the seam:

| guard | covers |
| --- | --- |
| [`packages/wire/test/export-surface.test.ts`](../packages/wire/test/export-surface.test.ts) | 69 runtime values, 11 event types, plus leaf↔barrel reference identity |
| [`cli/test/contract/export-surface.test.ts`](../cli/test/contract/export-surface.test.ts) | 78 runtime values, 57 types |
| [`packages/twin-github/test/access-control-catalog.test.ts`](../packages/twin-github/test/access-control-catalog.test.ts) | the 11 access-control values, now exercised rather than only listed |

[`cli/test/contract/barrel.test.ts`](../cli/test/contract/barrel.test.ts) closes
the gap the split created: `cli/src/types/shared.ts` merges two `export *`s, so it
asserts every re-exported schema is the *same object* as its owner's (a second zod
copy breaks discriminated unions without breaking a type) and that the two halves
share no name.

The `/v1` fixture corpus split on the same line:
`packages/wire/test/fixtures/v1/event/**` (the F-1201 event-kind gate, with
`trace-contract.json` and its emitter) and `cli/test/fixtures/contract/v1/**`
(session / run / plan / usage).

## What the dissolution retired

The dual-build model went with the package. `shared-types` alone shipped
`exports: "./src/index.ts"` with no `dist`, so `build:runtime` emitted `.js` in
place beside every `.ts` to satisfy NodeNext specifiers — untracked files that
shadowed the sources. Three workarounds existed only for that, and all three are
gone: `contract/run.mjs`'s `cleanRuntimeJs()` walker,
`scripts/probe-example-tools.mjs`'s `withSharedTypesRuntime` cleanup, and the twin
Dockerfiles' `COPY packages/shared-types` of the whole directory (now
`package.json` + `dist`, like the sdk). CONTRACT.md 1.6.0 records the resulting
runtime-arrangement change; nothing else in that document moved.
