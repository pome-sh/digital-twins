# /v1 wire fixture corpus (FDRS-613)

A shared, framework-agnostic JSON corpus of representative `/v1` wire payloads.
`pome-sh/pome-twins` is the canonical home for these fixtures and the
`@pome-sh/shared-types` package that parses them. Cloud consumers validate
against the published package contract; they no longer mirror this source tree
as a second owner.

## Layout

One directory per `/v1` schema. The directory name is the schema key:

```
planTier/                        → planTierSchema
createSessionRequest/            → createSessionRequestSchema  (POST /v1/sessions; 0.3.0-era scenario_* vocab)
createSessionRequestTaskVocab/   → createSessionRequestSchema  (W3 task_* vocab, FDRS-653)
createSessionResponse/           → createSessionResponseSchema (POST /v1/sessions)
usage/                           → usageResponseSchema         (GET  /v1/usage)
run/                             → runSchema                   (Run row; 0.3.0-era scenario_* vocab)
runTaskVocab/                    → runSchema                   (W3 task_* vocab, FDRS-653)
event/<Kind>/                    → otelEventSchema             (events.jsonl row; one dir per union member)
```

Each `*.json` file is a single wire value: an object, or (for `planTier`) a
bare JSON string. Every fixture MUST parse successfully under the mapped schema.

### `event/` — one directory per event kind (F-1201)

`event/` is the one nested corpus. It holds `events.jsonl` rows, one directory
per member of the event union (`otelEventSchema` = the seven `eventSchema`
variants plus `OtelSpanEvent`), and **a fixture's directory is its `kind`**.

Adding a member to the union without adding a fixture is a build failure:

```
$ npm run emit:trace-contract -w @pome-sh/shared-types
trace-contract.json event-fixture coverage failed (F-1201):
- no fixture for event kind(s): MyNewEvent.
```

`scripts/emit-trace-contract.mjs` enumerates the kinds **from the zod union** at
emit time and writes them into `trace-contract.json` as `eventKinds`, so the
coverage requirement cannot be satisfied by a stale list. Both `emit` and
`--check` refuse — regenerating is not an escape hatch. Renaming a kind is the
same failure from the other side: the old directory now describes a member the
union does not have, and that is rejected too.

Before F-1201 this corpus was 18 session/run/plan shapes and nothing else. The
contract carried zero event-kind entries, and `check:trace-contract` compared
bytes that no schema change could move — which is how M1 shipped `LlmTurnEvent`
with no fixture anywhere and CI stayed green.

Fixtures are written the way an emitter writes them (`TwinHttpEvent` keeps the
runtime's field order, with `kind` / `event_id` / `parent_id` last), and cover
the modes each schema documents rather than just one row per kind: baseline
vs. TLS-terminated `LlmCallEvent`, a `HookEvent` with and without `tool_name`,
an `LlmTurnEvent` where every absent SDK value is an explicit `null`. The
`OtelSpanEvent` rows are generated through `mapOtelSpanToEvent` — hand-writing
one is impractical, since the schema requires `ts`, the id chain, and every
typed projection to agree with the attribute bag.

### The two vocabularies (FDRS-653)

Shared-types 0.5.0 renamed everything "scenario" to "task" on the wire (and
criterion kinds `D`/`P` to `code`/`model`) behind a tolerant reader. The
original dirs deliberately KEEP their 0.3.0-era payloads: they are the proof
that 0.3.0 artifacts (and shipped CLIs vendoring shared-types 0.3.0) still
parse. The `*TaskVocab` dirs hold new-vocabulary payloads. Do NOT add
new-vocab payloads to the original dirs; those directories remain the
tolerant-reader compatibility corpus.

## Scope

Deliberately scoped to the `/v1` wire surface (`planTier`, `createSession`,
`usage`, `run`) plus the `events.jsonl` row (`event/`). It is **not** whole-file
byte parity, whole-schema equality, or a guard for every possible
loosening/removal, and it does **not** cover cloud-only billing schemas.
Byte-for-byte repo parity is a non-goal after M8; represented fixture parsing
through the published package is the contract.

The `event/` requirement is coverage, not exhaustiveness: one fixture per kind
is the floor, and a kind whose shape changes should grow a fixture for the new
mode rather than have its existing one edited in place.

## How this repo consumes it

`packages/shared-types/test/v1-fixture-parity.test.ts` parses every fixture under
the mapped schema, and asserts the `event/` corpus covers every union member —
a check stated to the *type* checker there, and to *zod* in
`scripts/emit-trace-contract.mjs`, so a bug in either derivation shows up as a
disagreement. `scripts/emit-trace-contract.test.mjs` covers the gate itself.
Downstream repos should consume the published `@pome-sh/shared-types` package
instead of vendoring or mirroring this corpus.
