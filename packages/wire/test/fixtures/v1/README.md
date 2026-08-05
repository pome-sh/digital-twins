# /v1 event-row fixture corpus (FDRS-613, F-1201)

A framework-agnostic JSON corpus of representative `events.jsonl` rows — the wire
payloads for `@pome-sh/wire`'s event union. `pome-sh/pome-twins` is the canonical
home. Cloud consumers validate against the contract; they no longer mirror this
source tree as a second owner.

The session / run / plan / usage half of the old corpus moved with its schemas to
`cli/test/fixtures/contract/v1/` in F-942.

## Layout — one directory per event kind

`event/` holds `events.jsonl` rows, one directory per member of the event union
(`otelEventSchema` = the seven `eventSchema` variants plus `OtelSpanEvent`), and
**a fixture's directory is its `kind`**.

```
event/<Kind>/*.json              → otelEventSchema
```

Each `*.json` file is a single wire value. Every fixture MUST parse successfully
under `otelEventSchema` and its `kind` MUST equal its directory name.

Adding a member to the union without adding a fixture is a build failure:

```
$ npm run emit:trace-contract -w @pome-sh/wire
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

## Scope

Deliberately scoped to the `events.jsonl` row. It is **not** whole-file byte
parity, whole-schema equality, or a guard for every possible
loosening/removal. Byte-for-byte repo parity is a non-goal after M8; represented
fixture parsing through the package contract is the contract.

The `event/` requirement is coverage, not exhaustiveness: one fixture per kind
is the floor, and a kind whose shape changes should grow a fixture for the new
mode rather than have its existing one edited in place.

## How this repo consumes it

`test/v1-event-corpus.test.ts` parses every fixture under `otelEventSchema` and
asserts the corpus covers every union member — a check stated to the *type*
checker there, and to *zod* in `scripts/emit-trace-contract.mjs`, so a bug in
either derivation shows up as a disagreement.
`scripts/emit-trace-contract.test.mjs` covers the gate itself.
