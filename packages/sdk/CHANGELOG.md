# @pome-sh/sdk

## 0.6.0 — 2026-07-28

Minor, not patch: `CheckDefinition.description` and `CheckParamType.example`
are REQUIRED, which is a published signature change (`PACKAGE_RELEASE.md` —
0.x minor plays the major role). 0.5.2 was a patch because it only *added*
exports. `npm run test:contract` is green, but it is a runtime suite and
required-ness is a compile-time property, so it is structurally blind to this
class of change. Every implementer today is in this repo.

- `CheckDefinition.description` — what the predicate actually compares.
  Required because an authoring surface can only show what is declared, and a
  rendered sentence wider than its check is the one defect this architecture
  makes easier (Shankar et al., UIST '24 §7.3.3).
- `CheckParamType.example` — a valid value per slot, asserted against its own
  `pattern` inside `defineCheck`, so a type whose example is invalid cannot
  ship. A regex source is not a prompt.
- `checksDigest(defs)` — one implementation of "hash the binding surface",
  called by both the control plane and the CLI, which resolve declarations
  from independent npm pins. Hashes `id`, `substrate` and the COMPILED
  pattern; never `description` or `example`, because a prose edit changes no
  sentence and must never refuse an author's write.
- `CheckBindingShape` — the subset that decides binding. `checkPattern` and
  `checkNearMissPattern` now take it, so a heterogeneous registry can be
  hashed without an args-erasing cast.

## 0.5.2 — 2026-07-28

Additive: `@pome-sh/sdk/checks`, the assertable check vocabulary (F-1073).

A check declares an English template with typed parameter slots; both the
rendered sentence and the matcher that binds it are derived from that one
template, so a declaration and its regex cannot drift apart. `defineCheck`
validates the declaration at module load — a slot with no type, a type no
slot uses, or a repeated slot are all hard errors rather than a check that
silently binds nothing.

`vacuityMutant` returns mutated ARGS rather than a mutated sentence, so the
splice-the-wrong-literal hazard that forces a hand-written mutant sentence
per rule is unreachable.

No existing surface changed; `npm run test:contract` green.

## 0.5.1 — 2026-07-21

Dependency-only patch: repin `@pome-sh/shared-types` to 0.12.0 (manifest data
model + slug authority, F-818). No SDK surface change.

## 0.5.0 — 2026-07-20

Additive MCP / recorder contract for the upcoming Gmail twin. Existing
GitHub, Slack, and Stripe tool listings and calls stay byte-identical when
the new optional fields are unset.

- `ToolSpec.title` / `ToolSpec.outputSchema` — optional MCP list metadata;
  successful JSON-RPC `tools/call` includes `structuredContent` only when
  `outputSchema` is declared.
- `toolListExtras()` helper keeps optional list keys absent when unset.
- Upstream `annotations` remain independent of `ToolSpec.mutation`
  (mutation is still local-state truth for the recorder).
- `TwinDefinition.recordingProjection` — optional pre-redaction event
  projection (MIME/attachment digests before secret scrubbing).

No breaking changes; `{before,after}` `state_delta` unchanged.

## 0.4.0 — 2026-07-13

Publish the `ensureTwinAuthSecret` server helper so the digest-pinned twin
snapshot build (which installs the published SDK, not the workspace copy) can
compile the twins that now call it on non-loopback boot.

- New export `ensureTwinAuthSecret(twin, host)` from `@pome-sh/sdk/server`
  (added workspace-side in #109; `twin-{github,slack,stripe}` call it and now
  pin `@pome-sh/sdk@0.4.0`).

No breaking changes.

## 0.3.1 — 2026-07-10

SQLite driver swapped from `better-sqlite3` to the `node:sqlite` builtin
(F-703) — zero native dependencies; a fresh install needs no compiler
toolchain.

- `openTwinDatabase()` / `TwinDatabase` reimplemented on `node:sqlite`:
  same-shape `transaction(fn)` (+ `.immediate`) backed by
  `BEGIN [IMMEDIATE]`/`COMMIT`/`ROLLBACK`, joining an already-open
  transaction via `SAVEPOINT` (better-sqlite3's nesting semantics).
  `TwinRunResult` shape unchanged.
- `better-sqlite3` dropped from `peerDependencies` — nothing native to
  install, optional or otherwise.

No API changes.

## 0.3.0 — 2026-07-10

Durable write-through recorder (the CLI's crash-safe local runs build on this;
unblocks the `@pome-sh/cli` first publish, F-727).

- New server exports: `createFileBackedRecorderStore` — a file-backed
  `RecorderStore` that streams twin HTTP events write-through to the run's
  `events.jsonl`, so runs survive process death without duplicating finalize
  rows — and `toTwinHttpEventRow`.
- `RecorderStore` gains `flush()` and `close()`.

No breaking changes; additive only.

## 0.2.0

First npm-published release (F-714). The twin engine: `defineTwin()` +
`serve()` — HTTP mounting, bearer auth, recorder + redaction, MCP dispatch,
SQLite driver, and the admin gate behind every first-party twin.

### Breaking changes

- Removed the deprecated `localhostOnly` re-export from the server surface
  (FDRS-616). It was a back-compat alias for `requireAdminAuth` — import
  `requireAdminAuth` instead; semantics are identical.

### Changes

- The admin gate is now the shared mirrored `admin-gate.ts` module, and the
  client IP it checks comes from a runtime-neutral accessor: an explicit
  `setClientIp()` override set by the serving bridge, falling back to
  `@hono/node-server/conninfo`'s official `getConnInfo` helper — no more
  reads of the bridge-private `c.env.incoming.socket` shape (FDRS-587).
  Gate semantics are unchanged: timing-safe `X-Admin-Token` when
  `TWIN_ADMIN_TOKEN` is set, loopback-only otherwise, default-deny on
  unknown remote in production.

## 0.1.0

Initial version.
