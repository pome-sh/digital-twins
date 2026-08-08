# @pome-sh/sdk


## 0.11.5 — 2026-08-08

New `check-redaction.ts`, reachable from `@pome-sh/sdk/checks`:
`probeRedactionSurvival`, `REDACTION_PLACEHOLDER` and `isRedacted` (F-1157).

`subject` closes the DETECTABLE half of the redaction class, and closes it at
the engine's door — a criterion whose declared subject the redactor destroys is
skipped before `evaluate` is called. That arm reads the DECLARATION and never
the state, deliberately, because it is what makes the authoring door and the
scoring door agree by construction. Nothing measured the other half: a slot the
subject arm does not name, which a redactor eats anyway.

`probeRedactionSurvival` measures it, per declared slot, by destroying that
slot's literal inside the check's own `discriminatingWorlds` and reading both
verdicts. The question is asked of the FAILING world — does a real `failed`
become a real `passed` — because the passing world passes by construction and
cannot tell a predicate that re-derived the fact from one whose assertion went
trivial. An earlier version asked only the passing arm and reported all ten of
twin-github's `{repo}` slots as vacuous passes, when `findRepo` had simply
matched on `owner`/`name` after `full_name` was masked.

Seven outcomes, of which one is a wrong verdict rather than a missing one:
`vacuous_pass`, `abstains`, `false_fail`, `discriminates_anyway`,
`declared_subject`, `absent_from_world`, `throws`. Each twin's
`checks-contract.test.ts` forbids `vacuous_pass` and `throws` outright and
ledgers the rest, so the class is counted rather than assumed.

Additive: no existing export moved and no declaration's behaviour changed.


## 0.11.4 — 2026-08-07

`loadMcpToolFixture` and the rest of `mcp-tool-fixture.ts` are now reachable on
their own `@pome-sh/sdk/mcp-tool-fixture` subpath, alongside `./server`,
`./parity`, `./checks` and `./db`. The root barrel still exports them — Node
callers are unaffected.

The root barrel is not a free way to reach a dependency-free module: it
re-exports `openTwinDatabase` from `./db.js`, whose first line is
`import { DatabaseSync } from "node:sqlite"`. Importing `@pome-sh/sdk` for
`loadMcpToolFixture` therefore loads the SQLite driver, and any runtime without
that builtin — bun, which is what pome-cloud's fidelity-watch runs — cannot load
the importing module at all. `mcp-tool-fixture.ts` has no imports of its own;
this subpath is how a caller gets it that way.

## 0.11.3 — 2026-08-06

A shared, hash-locked MCP tool-table fixture loader (F-1325).

`loadMcpToolFixture` validates a declared provenance contract — `substrate`,
`endpoint`, `method`, `protocol`, `protocolVersion`, `captureDate`,
`rawFileSha256`, and the `configuration` an upstream substrate was read under —
and asserts the raw listing hashes to the sha its meta declares.
`deriveMcpToolTable` joins that listing to a twin's implementations 1:1 in both
directions; `diffServedToolsAgainstFixture` and
`deriveCanonicalMcpToolListing` are its test-facing halves.

`runFidelityParity` now takes `fixtureToolNames` instead of `liveToolNames`:
`fidelity.inventory.json` is bound to the fixture rather than to the code
table.

## 0.11.1 — 2026-08-04

Dependency-only patch (#302): `hono` `^4.12.31` → `^4.13.0`, `zod` `^4.1.13` → `^4.4.3`.
No source file changed and `npm run test:contract` is green, so the surface is
identical — this exists so the npm artifact stops differing from `main`, which is
the staleness the publish skip-guard cannot see.

## 0.11.0 — 2026-08-04

Twin HTTP rows carry the new parent vocabulary (F-1200).

- `toTwinHttpEventRow` emits `parent_event_id` instead of `parent_id`; its
  return type changes with it.
- The value is still `null`, and that is not a stub: a twin runs in its own
  process and cannot know the `event_id` of the agent-side `ToolUseEvent` that
  caused the call. It carries the causing tool's id on `correlation_id`
  (always) and `tool_call_id` (when the twin pins `stampToolCallId`), and the
  CLI's post-run merge resolves the parent from that.
- Requires `@pome-sh/shared-types@0.14.0`.

## 0.10.1 — 2026-08-03

A state-reading check can say WHERE it looked (F-1197).

- New `CheckOutcome.evidenceStatePaths` — the state-substrate sibling of
  `evidenceEventIds`, carrying RFC 6901 JSON Pointers into the twin's exported
  state tree. Optional and additive; a check with nothing to name omits it, the
  same omit-don't-empty discipline the existing field has.
- New `statePath(...segments)` / `childStatePath(base, ...segments)` builders and
  `resolveStatePath(tree, pointer)` reader, in `check-state-path.ts` and
  re-exported from `@pome-sh/sdk/checks`.
- New `probeStateCitation(def, args)` — pure, no test framework, the sibling of
  `probeDiscrimination`. Returns `cites` / `declined` / `uncited` /
  `unresolvable` / `malformed`, and probes BOTH declared worlds.

The measurement behind it: `evidenceEventIds` can only be filled by a
`substrate: "tape"` check, and of the 45 checks the five first-party twins
declare, 8 read the tape. The other 37 read state and could cite nothing at all —
a verdict that renders as an inert row, which a reader cannot tell from a verdict
with no evidence behind it. Every Slack `[code]` criterion was in that set,
because Slack declares no tape check.

A pointer ALWAYS addresses `final`, never `seed`, even for a delta check: the
consumer has the final tree on screen, so a pointer into a seed it is not
rendering would relocate the dead affordance rather than remove it.

`probeStateCitation` probes both arms deliberately. A citation present on a
passing world and absent on a failing one would be worse than none, because its
absence starts reading as a verdict class.

No binding surface moved — `checksDigest` hashes `{id, substrate, pattern}`, so
no pin looks skewed and no rendered sentence changed.

## 0.10.0 — 2026-07-30

A declared check can name the worlds it discriminates between (F-1126).

- New required `discriminatingWorlds(args)` on `CheckDefinition`, returning a
  `{ passing, failing }` pair of `CheckSubstrate`s or `null`.
- New `probeDiscrimination(def, args)` — pure, no test framework — returning
  `discriminates` / `declined` / `broken` with the arm that broke. Each twin's
  contract test owns the admitted-null ledger, so an empty ledger cannot
  silently excuse anything.

It is a PAIR rather than the failing half alone, and the reason is measured:
every state-reading check resolves its selector before it asserts, and a
selector miss returns a real failure rather than a skip — so 11 of GitHub's 13
declarations returned `passed: false` against an empty world, a fixture that
proves nothing. The third arm rejects a failing world whose reason is the one an
empty world already gives.

`checksDigest` is unchanged and does not hash the new field: a fixture is not
part of the binding surface, so this cannot skew a CLI↔prod handshake.

Minor: a required field on a published interface. Every declaration must add
one.

## 0.9.0 — 2026-07-29

The recorder captures request headers and the tool that was called (F-1125).
Minor: it requires `@pome-sh/shared-types` >= 0.13.0, and `CheckTapeEvent` grows
two fields a tape check can read.

### Added

- `recordedRequestHeaders(c)` and `setRecordedTool(c, tool)` (new
  `request-capture` module, re-exported from `@pome-sh/sdk/server`) — the ONE
  answer to "which headers get recorded" and "what counts as the tool that was
  called", shared by all five emission sites. Twins that build recorder events by
  hand must use them; five copies of that policy is five chances for one twin's
  tape to be the one a header-reading check cannot see.
- `handle({ tool })` — declare the twin action a REST route performs, recorded as
  `RecorderEvent.tool`. Use the matching MCP tool's name.
- `CheckTapeEvent.request_headers` / `CheckTapeEvent.tool`. Both optional: a
  recording made before they existed still has to parse, and `undefined` is a
  THIRD world a check must not collapse into the other two — it means "this
  recording predates the field", not "the header was not sent".

### Changed

- Every recorder emission site — `handle()`, JSON-RPC `tools/call`, the two
  legacy MCP dispatch routes, and the failure injector — now populates
  `request_headers`, and stamps `tool` where it knows one. The MCP surfaces stamp
  the name the CALLER used, including when the tool is unknown or its arguments
  were rejected: "was it called" is a question about the attempt.


## 0.8.0 — 2026-07-29

A declared check can read the ordered call tape (F-1076, settling D1's open
half). Minor, not patch: `CheckSubstrate.tape` is a REQUIRED key, so a consumer
that constructs a substrate — pome-cloud's declaration adapter is the one that
does — fails to typecheck until it supplies one (`PACKAGE_RELEASE.md` — 0.x
minor plays the major role).

- `CheckSubstrate.tape: readonly CheckTapeEvent[] | null` — the recorded HTTP
  call tape, scoped to the criterion's twin by the consuming engine and ordered
  oldest-first. **That ordering is a contract**, not an artifact of how the blob
  happened to be parsed; a check may rely on it.
- Required key, nullable value, deliberately mirroring `seed`. An optional key
  is one every later consumer forgets to pass, and forgetting it would hand a
  tape check a hole — letting a negative criterion pass over a tape nobody read,
  which is the one failure D4 forbids. `null` and `[]` are different worlds:
  "nobody handed me a tape" versus "the agent called nothing".
- `CheckTapeEvent` — one recorded call, as a `substrate: "tape"` check sees it.
  The frozen v1.0 `TwinHttpEvent` with every field optional/nullable so a
  malformed row cannot crash a predicate. It lives here rather than in the
  consuming engine for the same reason the declarations do: a consumer-side copy
  drifts silently, surfacing only when a predicate reads a field the copy forgot.
- **No `headers`, and this is not an oversight.** The recorder never captured
  them, so an assertion like "the retry includes X-PAYMENT" is unanswerable at
  any substrate width. Verified against `recorder-events.ts` rather than assumed.
  Closing that gap is a recorder change, tracked separately.
- `CheckOutcome.evidenceEventIds?: string[]` — the calls an outcome asserted
  against. Without it, moving a tape predicate into a declaration would have
  dropped F-980's citations on the floor: a silent downgrade sold as a refactor.
  Omit the key rather than sending `[]`; absent and empty mean the same thing
  downstream, and an empty affordance would have to be special-cased by every
  reader of the persisted row.

## 0.7.0 — 2026-07-29

Minor, not patch: `defineCheck` now REJECTS a declaration it used to accept, so
a consumer that upgrades can fail at module load. That is a behaviour change on
a published entry point (`PACKAGE_RELEASE.md` — 0.x minor plays the major role).

- `oneOf(name, values, example?)` — a param type for a slot whose value comes
  from a closed set. The legacy GitHub regexes spelled these inline as
  `(open|closed)`, where no authoring surface could read them; as a param type
  the set travels with the declaration. Non-capturing and value-escaped, so a
  member carrying a regex metacharacter matches itself and only itself.
- `defineCheck` rejects a param type whose `pattern` opens its own capture
  group. Every consumer reads capture group i+1 as template slot i, so one
  stray group shifts all of them and hands each predicate its neighbour's
  argument — a silent, total mis-grade. This is the change that makes 0.7.0 a
  minor: a declaration using `(a|b)` where `(?:a|b)` was meant threw nothing
  before and throws now.
- `VACUITY_SENTINEL`, `VACUITY_SENTINEL_SNAKE`, `VACUITY_SENTINEL_NUMBER` — the
  values a `vacuityMutant` substitutes. They move here from pome-cloud's probe
  because the declaration WRITES them and the probe RECOGNISES them; two copies
  of one fact skew silently, and the failure mode is that the probe stops
  recognising its own mutants and every check reads as un-probed.

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
