# @pome-sh/twin-linear — CHANGELOG


## Unreleased (patch)

Two declared-check descriptions stop explaining what a retired rule used to do.
`linear.issue-has-label` and `linear.issue-assignee` still behave identically —
the label comparison is case-insensitive, the assignee reference still matches
email, name or displayName — but the descriptions say so on their own terms.
They are published prose: pome-cloud generates its authoring reference from
these strings, so the docs page picks the new wording up on the next pin bump.

`parseSeed` drops a top-level `_meta` before validating (F-1689). This schema was
already `.strict()` at every level, which is what made it refuse the provenance
block `pome compile-seeds` stamps on every `<task>.seed.json`. `_meta` is dropped,
not declared, so `seedFields()` and the generated starter are unchanged.

## 0.4.1 — 2026-08-11

**`extensions` is declared on both `/graphql` surfaces, and answered before
authentication** (F-1385). GraphQL-over-HTTP's fourth envelope member is what
Apollo clients send for automatic persisted queries. The twin declared it
nowhere, so since F-1372 flipped this twin to `ignore` it was discarded and the
query served — where real Linear answers on it.

**The ticket's premise was wrong, and re-measuring is what caught it.** F-1385
was filed reading Linear's 400 as "persisted queries are switched off". Measured
against `https://api.linear.app/graphql` on 2026-08-11, Linear runs APQ in
**verify-only** mode: it checks that `sha256Hash` is the SHA-256 of the `query`
it arrived with, and the 400 is that check failing. Send the correct hash and
the request is served. Had the twin rejected every `extensions` payload — the
literal shape of the fix as filed — an Apollo client with APQ enabled would have
failed the exam and worked in production, which is the failure class this whole
batch exists to remove.

Nothing is registered, by either side: a hash-only request answers
`PersistedQueryNotFound` even straight after the same hash arrived with its
query. So there is no persisted-query store here, only a hash to verify.

| Request | Answer |
| --- | --- |
| `extensions` absent, or carrying no `persistedQuery` | served |
| `persistedQuery` whose `sha256Hash` matches `query` | served |
| a hash that does not match, `version` ≠ 1, or no hash | 400 `INTERNAL_SERVER_ERROR` |
| `persistedQuery` with no `query` | 200 `PersistedQueryNotFound` |
| `extensions` that is not a usable object | 400 `BAD_REQUEST`, worded per surface |

**Answered ahead of `bearerAuth`**, on a router wrapped around the engine's
session app the way the OAuth endpoints already are. Linear answers all of the
above with no credential at all, while the same request without `extensions` has
to reach the auth check to earn its 401 — so a twin that rejected after its own
auth check would show an agent with a stale token a 401 where Linear shows a
400. `test/route-input-declarations.test.ts` pins the ordering with a
deliberately-bad token, and drives every row of the table over the real HTTP
wire.

**The gate reads a CLONE of the request, and that is load-bearing.** The
engine's recorder captures an event's `request_body` with its own
`c.req.raw.clone().json()`, and `clone()` throws once the body stream has been
disturbed — recording `null` rather than failing. A gate that drained the body
ahead of the recorder therefore blanked the tape on every recorded `/graphql`
request with nothing anywhere going red. The first draft of this change did
exactly that. The declaration is still the only thing that reads a value by
name; the clone decides which `Request` it parses, not what may be read off it,
and `test/route-input-declarations.test.ts` now asserts the tape carries the
body.

Declared inputs: 120 → **122**. The observed behaviour, and the two things this
does not model (no persisted-query store, no Apollo CSRF prevention), are
recorded in `FIDELITY.md`; the full transcript is in
`docs/undeclared-route-inputs.md`.


## 0.4.0 — 2026-08-09

The agent-session **mutation inputs** are Linear's now, and so is the model they
imply (F-1176). 0.3.0 fixed the output type and said so in the guard's own
words — *do not read this file as evidence about the input surface*. This is
that surface.

**Breaking, on all four inputs.** Every field below is one Linear does not
declare, verified against `https://api.linear.app/graphql` directly:

| Mutation | Was | Is |
| --- | --- | --- |
| `agentSessionUpdate` | `id: String` argument; input `{ id, status, plan, externalUrls }` | `id: String!` argument; input `{ plan, externalUrls }` |
| `agentSessionCreateOnIssue` | `{ issueId, appUserId, plan, externalUrls }` | `{ issueId, externalUrls }` |
| `agentSessionCreateOnComment` | `{ commentId, appUserId, plan, externalUrls }` | `{ commentId, externalUrls }` |
| `agentActivityCreate` | `{ sessionId, type, body, ephemeral }` | `{ agentSessionId, content, signal, ephemeral }` |

**A session's status now follows its activities.** This is the behavioural half,
and it is why the change is a minor rather than a patch: upstream there is no
`status` on `agentSessionUpdate` at all, so an agent written against real Linear
literally could not drive the twin the way the twin expected, and vice versa. A
session still starts `pending`; `thought` / `action` make it `active`,
`elicitation` `awaitingInput`, `response` `complete`, `error` `error`, and
`prompt` returns it to `pending`. That table is the one invented thing in the
change — Linear says only that state "is updated automatically based on the
agent's emitted activities" and never publishes which yields which — so it is
named, bounded, and written up in `REFERENCE-DIVERGENCES.md`. Set a plan through
`agentSessionUpdate`, which is where Linear declares `plan`; it is no longer on
create.

**`content` replaces `type` + `body`.** Linear's `AgentActivityContent` is a
union discriminated on `type` whose six members are
`AgentActivity{Thought,Action,Response,Elicitation,Error,Prompt}Content`. Five
carry `body`; `action` carries `action` / `parameter` / `result` and no `body`
at all, which is why the old flat pair could not survive. The twin parses
`content` against those six members and refuses a malformed one at the boundary.
`AgentActivity` moves with it — accepting Linear's `content` while emitting an
invented `body` would round-trip to neither Linear nor itself — so the output
type is now `{ id, content, signal, ephemeral, createdAt, updatedAt,
agentSession, user }`. `session` was the twin's own spelling and is gone; `user`
is non-null, as Linear declares it.

**An existing `LINEAR_TWIN_DB` file migrates in place on open.**
`agent_activities` gains `content_json` and `signal`, carries each old row's
`{ type, body }` into content verbatim, drops `type` and `body`, and re-adopts
any activity whose author the `ON DELETE SET NULL` foreign key had cleared. The
carry is literal even for `action`, whose upstream member has no `body`:
inventing an `action` / `parameter` split out of one free-text field would be
worse than a faithful record of what the row said. Idempotent, and a no-op on a
database created by the current schema.

**The guard covers the whole family now.** `GUARDED_TYPES` gains
`AgentSessionUpdateInput`, `AgentSessionCreateOnIssue` / `OnComment`,
`AgentActivityCreateInput`, `AgentActivity` and `AgentActivitySignal` — it went
red on all of them the moment they were added, which was the point — and
`test/linear-schema-subset.test.ts` gains a block that proves the guard can
fail, driving the same comparison against a schema built to be wrong. The
SCOPE note that carved the input surface out of F-1172's claim is deleted.

Two scalar-level gaps stay open and are written up rather than fixed, because
the guard is name-based by F-1172's design: input `plan` is `String` where
upstream is `JSONObject`, and output `content` is `JSON!` where upstream is the
union. Input `content` **is** `JSONObject!`, as upstream.

`packages/twin-linear/route-inputs.json` changes by two lines —
`agentSessionUpdate`'s `id` argument is `String!`, required — which is the
declared-fidelity lane seeing the second, smaller divergence close.

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

New `./seed` subpath export (F-1306): `linearSeedSchema`, `parseSeed`,
`defaultSeedState` and the rest of `seed.ts` — a module whose only imports are
`zod`, `./types.js` and `./webhook-url.js`. Nothing else changed.

The CLI's task parser needs a seed schema on its startup path and was reading it
from the package ROOT, which also exports `LinearDomain`,
`openLinearTwinDatabase` and `createLinearTwinApp`. A schema lookup therefore
loaded 241 KB of this twin's domain, GraphQL executor and MCP surface on every
`pome` invocation, including `pome --version`. The root keeps exporting all of
these names.

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

- 7 declarations now fill `CheckOutcome.evidenceStatePaths` (new in
  `@pome-sh/sdk` 0.10.1) with RFC 6901 pointers into this twin's exported tree.
- `check-state.ts`'s resolvers return the pointer they walked. `Resolved<T>`'s
  found arm gains `path`; its missing arm gains an optional `searched`, naming
  the collection a failed lookup scanned.
- `checks-contract.test.ts` gains the citation gate and an EMPTY
  `HONEST_UNCITED_CHECKS` ledger.

A failed lookup cites too, and that is the half worth knowing about. A title that resolves to nothing, or to two issues, is the refusal task 26 turns on.
So the honest citation on that arm is not the row — there is none — but the list:
*this is where I looked, see for yourself that it is not in it.*

Requires `@pome-sh/sdk` 0.10.1: the declarations call `statePath` /
`childStatePath`, which 0.10.0 does not export.

No sentence, template, substrate or check id changed, so `checksDigest` is
identical and no criterion re-binds.

## 0.3.0 — 2026-08-02

**BREAKING RELEASE — read this before upgrading.** Two things a consumer must
act on:

1. **`AgentSession` is renamed to Linear's real field names (F-1172).** No
   aliases, no deprecation window: `state` → `status` (now a real
   `AgentSessionStatus` enum), `externalUrl` → `externalUrls` (a collection),
   `agentUser` → `appUser`, plus `id: ID!`, `createdAt` / `updatedAt: DateTime!`
   and `plan: JSON`. Queries, mutation inputs, the `/_pome/state` export and the
   `AgentSessionEvent` webhook payload all change shape. Any agent, task or
   check that names the old fields must be updated.
2. **An existing `LINEAR_TWIN_DB` file is migrated in place on open.** The
   `agent_sessions` table is rewritten (`agent_user_id` → `app_user_id`,
   `state` → `status`, `external_url` → `external_urls_json`), and the three
   retired status values are remapped: **`completed` → `complete`,
   `failed` → `error`, `canceled` → `stale`.** The migration is idempotent and
   there is no downgrade path — a 0.2.x twin cannot read a migrated database.

Also in this release: partial updates stop wiping fields the caller never
mentioned (F-1166), across `agentSessionUpdate` and six sibling mutations.

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
  time instead. Scope: the guard covers the output type and the one input
  object the twin mirrors exactly. The mutation-input surface
  (`AgentSessionUpdateInput`, `AgentSessionCreateOnIssue` / `OnComment`,
  `AgentActivityCreateInput`) still diverges from Linear, predates this change,
  and is tracked separately.
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
