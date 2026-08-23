# /v1 control-plane fixture corpus

A framework-agnostic JSON corpus of representative `/v1` REST payloads and stored
rows. `pome-sh/pome-twins` is the canonical home for these fixtures and for the
schemas that parse them (`cli/src/contract/`). Cloud consumers validate against
the contract; they no longer mirror this source tree as a second owner.

Split out of `packages/shared-types/test/fixtures/v1/`. The
`events.jsonl` row half stayed with its schemas in
`packages/wire/test/fixtures/v1/event/`.

## Layout

One directory per `/v1` schema. The directory name is the schema key:

```
planTier/                        → planTierSchema
createSessionRequest/            → createSessionRequestSchema  (POST /v1/sessions; 0.3.0-era scenario_* vocab)
createSessionRequestTaskVocab/   → createSessionRequestSchema  (task_* vocab)
createSessionResponse/           → createSessionResponseSchema (POST /v1/sessions)
usage/                           → usageResponseSchema         (GET  /v1/usage)
run/                             → runSchema                   (Run row; 0.3.0-era scenario_* vocab)
runTaskVocab/                    → runSchema                   (task_* vocab)
```

Each `*.json` file is a single wire value: an object, or (for `planTier`) a bare
JSON string. Every fixture MUST parse successfully under the mapped schema.

## The two vocabularies

Shared-types 0.5.0 renamed everything "scenario" to "task" on the wire (and
criterion kinds `D`/`P` to `code`/`model`) behind a tolerant reader. The original
dirs deliberately KEEP their 0.3.0-era payloads: they are the proof that 0.3.0
artifacts (and shipped CLIs vendoring shared-types 0.3.0) still parse. The
`*TaskVocab` dirs hold new-vocabulary payloads. Do NOT add new-vocab payloads to
the original dirs; those directories remain the tolerant-reader compatibility
corpus.

## Scope

Deliberately scoped to the `/v1` control-plane surface (`planTier`,
`createSession`, `usage`, `run`). It is **not** whole-file byte parity,
whole-schema equality, or a guard for every possible loosening/removal, and it
does **not** cover cloud-only billing schemas. Byte-for-byte repo parity is a
non-goal after M8; represented fixture parsing through the contract is the
contract.

## How this repo consumes it

`cli/test/unit/wire/v1-fixture-parity.test.ts` parses every fixture under the
mapped schema and asserts the two-vocabulary normalization.
