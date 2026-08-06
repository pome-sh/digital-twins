# @pome-sh/twin-gmail — CHANGELOG


## 0.3.5 — 2026-08-06

Its MCP tool table is now derived from `fixtures/mcp-tools-list.raw.json`
rather than declared in TypeScript (F-1325). The fixture's provenance —
substrate, endpoint, protocol version, capture date and the sha of the raw
bytes — is validated at load, and the derivation is 1:1 in both directions, so
a tool the fixture does not declare and a fixture tool nothing implements are
each a throw at module load.

Name-neutral by construction: `tools/list` and the legacy `/mcp/tools` surface
are byte-identical before and after.

## 0.3.4 — 2026-08-06

New `./seed` subpath export (F-1306): `gmailSeedSchema`, `parseSeed`,
`defaultSeedState` and the rest of `seed.ts` — a module whose only imports are
`zod` and this twin's own fault/search-query validators. Nothing else changed.

The CLI's task parser needs a seed schema on its startup path and was reading it
from the package ROOT, which also exports `GmailDomain`, `openGmailTwinDatabase`
and `createGmailTwinApp`. A schema lookup therefore loaded 252 KB of this twin's
domain, REST routes and MCP surface on every `pome` invocation, including
`pome --version`. The root keeps exporting all of these names.

## 0.3.3 — 2026-08-04

Dependency-only patch (#302): `hono` `^4.12.31` → `^4.13.0`, `zod` `^4.1.13` → `^4.4.3`, `@hono/node-server` `^2.0.10` → `^2.1.0`.
No source file changed and `npm run test:contract` is green, so the surface is
identical — this exists so the npm artifact stops differing from `main`, which is
the staleness the publish skip-guard cannot see.

## 0.3.2 — 2026-08-04

- Re-pinned to `@pome-sh/sdk@0.11.0` for the F-1200 parent-vocabulary
  change: a recorded row now carries `parent_event_id` rather than `parent_id`.
  No change to this twin's own surface — `npm run test:contract` is green.

## 0.3.1 — 2026-08-03

Every state-reading check says where it looked (F-1197).

- 6 declarations now fill `CheckOutcome.evidenceStatePaths` (new in
  `@pome-sh/sdk` 0.10.1) with RFC 6901 pointers into this twin's exported tree.
- `check-state.ts`'s resolvers return the pointer they walked. `Resolved<T>`'s
  found arm gains `path`; its missing arm gains an optional `searched`, naming
  the collection a failed lookup scanned.
- `checks-contract.test.ts` gains the citation gate and an EMPTY
  `HONEST_UNCITED_CHECKS` ledger.

A failed lookup cites too, and that is the half worth knowing about. A message the export does not carry is the commonest refusal here, and it is the one a reader most wants to check.
So the honest citation on that arm is not the row — there is none — but the list:
*this is where I looked, see for yourself that it is not in it.*

Requires `@pome-sh/sdk` 0.10.1: the declarations call `statePath` /
`childStatePath`, which 0.10.0 does not export.

No sentence, template, substrate or check id changed, so `checksDigest` is
identical and no criterion re-binds.

## 0.3.0 — 2026-07-30

Gmail declares its assertable check vocabulary (F-1128, milestone A3).

- New `./checks` subpath: `GMAIL_CHECKS`, seven declarations, plus the
  `GmailCheckState` model they read (`check-state.ts`). pome-cloud deletes its
  hand-maintained mirror of that shape in the same milestone — the twin's model
  is now the only one.
- Four declarations are new and bind the six criteria A3 found unbound across
  tasks 22, 23 and 27: `gmail.message-has-label` (which clears three of them,
  because two tasks say the same sentence), `gmail.label-exists`,
  `gmail.draft-addressed-to` and `gmail.draft-count-at-least`.
- Three are carried across from pome-cloud's hand-written regexes:
  `gmail.mailbox-label-count`, `gmail.one-message-per-recipient` and
  `gmail.no-unsupported-endpoint`. The last drops the twin word — it is now the
  same sentence twin-github declares, resolved per-twin by the engine — so
  `examples/gmail-retry-notify` is rewritten to the rendered templates in the
  same commit.
- `gmail.draft-addressed-to` declares its recipient as the check's `subject`.
  pome-cloud has carried a prediction since F-1028 that this exact criterion
  becomes an unguarded redaction hazard the day a gmail draft-recipient
  predicate ships without one.
- Two shapes drove the state model and are pinned by tests rather than left as
  comments: an exported draft row carries no addressing at all (the recipient
  lives on the backing message, reached through `messageId`), and message
  bodies are digested away unconditionally — so no check on this twin can scan
  message prose.
- Ambiguity is closed in the reader rather than the grammar: a message id
  present in more than one mailbox returns `message_ambiguous` instead of
  grading whichever sorted first. Gmail mints ids per mailbox, and the corpus
  sentences carry no mailbox.
- New `test/fidelity-contract.test.ts` adds the state-shape parity arm gmail
  never had. The existing parity harness's rings are all about the tool surface;
  nothing had ever compared `exportGmailState()` against the shape a consumer
  reads.
- `vitest.config.ts` replaces the `test` script's hand-maintained file list.
  `faults.test.ts` had already fallen off it — a suite that exists, passes, and
  never ran.


## 0.2.1 — 2026-07-30

Dependency-only patch: repin `@pome-sh/sdk` to 0.10.0 (F-1126). No surface change.

The repin is not cosmetic. npm only symlinks a workspace sibling when the
declared pin matches its version; a stale pin makes npm install a nested
PUBLISHED copy instead, so the package is built and tested against the registry
rather than this tree. `scripts/check-workspace-pins-match-workspace.mjs` now
gates it.

## 0.2.0 — 2026-07-24

### Added

- Named `rate-limited` fault-injection seed primitive (F-917). Gmail seeds accept
  an optional `faults` array (default `[]`, opt-in). `rate-limited` throttles a
  target operation (default `messages.send`) by call count: the first
  `succeedFirst` calls succeed, the next `throttleFor` return 429
  `RESOURCE_EXHAUSTED` (retry hint in the body, no `Retry-After` header), then
  calls recover; the counter is per twin instance and cleared by
  `POST /admin/reset`. Default seed behavior is unchanged.

## 0.1.2 — 2026-07-23

Fix: declare `@hono/node-server` as a direct dependency. The twin's
`server.js` boots via the SDK `serve()` helper, which imports
`@hono/node-server` (an optional peer of `@pome-sh/sdk`). Without a direct
dependency, a clean install (e.g. the hosted Vercel Sandbox snapshot build)
failed to start the server with `ERR_MODULE_NOT_FOUND`. twin-github and
twin-linear already declared it; gmail now matches. No twin surface change.

## 0.1.1 — 2026-07-21

Dependency-only patch: repin `@pome-sh/sdk` to 0.5.1 (F-818 batch). No twin
surface change.

## 0.1.0 — 2026-07-20

First public release of the deterministic Gmail twin:

- Broad frozen Gmail v1 REST and upload surface with loud named 501 gaps.
- Captured ten-tool first-party Gmail MCP listing and structured results.
- Deterministic SQLite mailbox state, MIME handling, search, history, labels,
  drafts, settings, bounded state export, and recorder payload projection.
- CLI, scenario, runtime-contract, package, and signed-image integration.

Authentication is Pome-owned. `POME_GMAIL_TOKEN` aliases the session JWT and
the package does not implement Google OAuth or add `provider_credentials.gmail`.
