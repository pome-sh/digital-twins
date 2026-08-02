# @pome-sh/twin-linear — CHANGELOG

## Unreleased

- **BREAKING — `AgentSession` now uses Linear's real field names and types
  (F-1172).** The twin declared four fields Linear does not have, so an agent
  written against real Linear read `undefined` from the twin and an agent
  written against the twin broke in production. There is no alias and no
  deprecation window: a twin carrying both the old and the new name would still
  expose a field Linear does not declare, which is the defect itself.

  | was | is now |
  | --- | --- |
  | `state: String!` | `status: AgentSessionStatus!` |
  | `externalUrl: String` | `externalUrls: JSON!` |
  | `agentUser: User!` | `appUser: User!` |
  | `id: String!` | `id: ID!` |
  | `createdAt` / `updatedAt: String!` | `createdAt` / `updatedAt: DateTime!` |
  | `plan: String` | `plan: JSON` |

  `AgentSessionStatus` is now a real enum carrying Linear's six members —
  `pending`, `active`, `awaitingInput`, `complete`, `error`, `stale`. The twin
  previously accepted `completed`, `failed` and `canceled`, which Linear does
  not have; those are rejected now. All three are rewritten on open:
  `completed` → `complete`, `failed` → `error`, and `canceled` → `stale`
  (Linear has no cancellation state; `stale`, "no longer progressing", is its
  closest neighbour).

  **An existing `LINEAR_TWIN_DB` file migrates in place on open.**
  `agent_sessions` renames `agent_user_id` → `app_user_id` and `state` →
  `status`, adds `external_urls_json`, backfills a non-empty `external_url`
  into a one-entry collection (`[{ url, label: "" }]` — Linear's label is
  non-null and the old shape carried none), drops `external_url`, and maps the
  three retired status values. It is idempotent and a no-op on a database
  created by the current schema. Cloud's per-session databases are ephemeral
  (ADR-012) and unaffected. A status that still cannot be mapped now fails at
  the read boundary with a message naming the value and the cause, rather than
  surviving to die at GraphQL enum serialisation.

  `externalUrls` is a collection, matching Linear: it replaces the single
  nullable `externalUrl` string with a JSON array of `{ url, label }` objects,
  and it is never null (an empty array when there are none). The mutation
  inputs follow: `agentSessionCreateOnIssue` / `agentSessionCreateOnComment`
  take `appUserId` and `externalUrls: [AgentSessionExternalUrlInput!]`, and
  `agentSessionUpdate` takes `status` and `externalUrls`. F-1166's tri-state
  contract is unchanged — key absent or `undefined` leaves a field alone, and
  `null` clears it (`externalUrls: null` clears to `[]`).

  The `/state` export and the `AgentSessionEvent` webhook payload rename with
  the wire surface (`appUserId`, `status`, `externalUrls`).
- **Added: a guard that fails when the twin invents a field Linear does not
  have (F-1172).** `test/linear-schema-subset.test.ts` asserts the twin's
  `AgentSession`, `AgentSessionStatus` and `AgentSessionExternalUrlInput`
  members are a subset of Linear's, read from a committed, credential-free
  slice of Linear's real introspection response
  (`fixtures/linear-introspection.json`, refreshed by
  `node scripts/regen-linear-introspection.mjs`). The old drift only surfaced
  when a capture query happened to select the field; this fails at authoring
  time instead.
- **Fixed: partial updates no longer wipe fields the caller never mentioned
  (F-1166).** Nullable fields on update mutations are tri-state — key absent
  and key present with `undefined` both mean "leave alone", `null` means
  "clear". The twin tested presence with the `in` operator, but every caller
  builds its patch as an object literal with all keys present, so an
  `agentSessionUpdate` that only set `state` silently erased `plan` and
  `externalUrl`. The same shape bug affected `issueUpdate`, `issueLabelUpdate`,
  `updateProject`, `updateDocument`, and the MCP `save_issue`, `save_project`,
  and `save_document` tools; `save_document` with only a title additionally
  failed outright with a spurious reparenting error. Presence is now tested as
  `!== undefined` at both the input-parsing and domain layers.
- **Fixed: `issueUpdate` with an explicit `stateId: null` no longer erases an
  issue's lifecycle timestamps (F-1166).** The block that derives
  `started_at` / `completed_at` / `canceled_at` was gated on `stateId != null`,
  but the flags that wrote them were gated on `stateId !== undefined`, so a
  rename sent alongside `stateId: null` wrote the uncomputed nulls while
  `COALESCE` correctly held `state_id` — leaving a Done issue with no
  completion timestamp. The flags now match the guard. A real transition still
  clears the stamps.

## 0.2.0 — 2026-07-30

Linear declares its assertable check vocabulary (F-1129, milestone A3) — the
last of the five twins, and the one whose migration could not be a rename.

- New `./checks` subpath: `LINEAR_CHECKS`, eight declarations, plus the
  `LinearCheckState` model they read (`check-state.ts`). pome-cloud deletes its
  hand-maintained mirror of that shape in the same milestone — the twin's model
  is now the only one. `LINEAR_CHECKS` is also re-exported from the package
  root, as twin-slack does.
- **Every check names its TEAM**, where twin-slack's vocabulary names no scope
  at all. `seed.ts` validates issue-title uniqueness via `issueTitlesByTeam` —
  per team, not per workspace — so a title-keyed selector over a two-team world
  is exactly the ambiguity twin-github's repo rule exists to close. The contract
  test enforces it, and only a check that reads no state may be ledgered out.
- **A selector miss FAILS; a truncated export SKIPS.** twin-github fails on a
  miss and twin-slack skips; Linear needs both from one resolver, so
  `Resolved<T>` carries the disposition. The split is evidenced rather than
  chosen: `state.ts` exports `exportBounds.truncatedCollections`, so the twin
  itself reports when rows were dropped past `STATE_EXPORT_CAP`. That is the
  only place in this vocabulary where "not found" and "absent" are different
  facts, and neither `GitHubCheckState` nor `SlackCheckState` has an analogue.
- Five checks read an issue row — `linear.issue-exists`, `linear.issue-state`,
  `linear.issue-has-label`, `linear.issue-estimate`, `linear.issue-assignee` —
  two read comments, one reads the tape. `linear.issue-threaded-reply` is the
  only `seed+final` member: it asserts a reply whose parent existed IN THE SEED,
  because a final-only reading is satisfied by an agent that posts a comment and
  then replies to itself.
- `linear.no-unsupported-endpoint` drops the twin word — it is now the same
  sentence twin-github and twin-gmail declare, resolved per-twin by the engine.
- **`linear.issue-lifecycle` is NOT migrated**, and that is a narrowing rather
  than an oversight. A declared `... is {lifecycle}` near-misses every
  `is in state "..."` sentence and would report a corrupted state criterion under
  a check the author never picked. It had zero corpus users; `is in state "Done"`
  / `"Canceled"` re-expresses what mattered.
- `cli/tasks/24`, `25` and `26` are rewritten in the same commit. Six of the nine
  shipped criteria named their subject with "that issue", with no subject at all,
  or by pointing at an id in the seed — and a rendered sentence cannot carry a
  pronoun, because a check only ever sees its own arguments. Task 26 LOSES a
  criterion rather than gaining a subject: `linear.issue-state` fails on a
  missing issue and already subsumes `An issue titled "..." exists`.

## 0.1.1 — 2026-07-30

Dependency-only patch: repin `@pome-sh/sdk` to 0.10.0 (F-1126). No surface change.

The repin is not cosmetic. npm only symlinks a workspace sibling when the
declared pin matches its version; a stale pin makes npm install a nested
PUBLISHED copy instead, so the package is built and tested against the registry
rather than this tree. `scripts/check-workspace-pins-match-workspace.mjs` now
gates it.

## 0.1.0 — 2026-07-21

First public release of the deterministic Linear twin:

- Frozen GraphQL + OAuth surface with SQLite-backed LinearCommands.
- Captured twenty-tool first-party Linear MCP listing and structured results.
- Deterministic seed/reset, webhooks log, bounded state export, and recorder
  payload projection.
- CLI, scenario, runtime-contract, package, and signed-image integration.

Authentication is Pome-owned for hosted runs. Local seeds include
`lin_test_admin` for `resolveCredential`, and `POME_LINEAR_TOKEN` aliases the
session JWT. There is no `provider_credentials.linear` contract.
