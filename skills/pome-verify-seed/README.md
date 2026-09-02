# pome-verify-seed

Use this skill before the first run of a new or changed task. Repeat verification after each seed or `[code]` criterion change.

## Seed gate

Validate the grammar and check bindings first. Then use `verify_seed` and `evaluate_criteria` to inspect each deterministic criterion on the initial state.

Compare every prompt claim with the seed. Correct invalid references and accidental pre-satisfied results. An all-negative task is valid when its preservation criteria are intentional and `always-scored`.

Use the [`seed verification checklist`](./references/seed-fidelity-checklist.md) for status meanings, probe teardown, and the report format.
