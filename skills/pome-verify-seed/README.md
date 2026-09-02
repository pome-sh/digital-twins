# pome-verify-seed

## Purpose

This skill checks whether a task seed creates a valid, consistent, and useful initial state.

## When to use

Use this skill before the first run of a new or changed task.

Use it again after any seed or deterministic-criterion change.

## Inputs

- A task identifier or complete task source.
- The task prompt, criteria, configuration, and seed.
- Optional access to a live Pome sandbox for read-only inspection.

## Outputs

- A seed verdict with supporting reasons.
- The initial status of each deterministic criterion.
- Seed-to-prompt consistency findings.
- Required seed or criterion corrections.

## Basic use path

1. Validate the task grammar.
2. Run `pome checks lint <task-file>` for local task files.
3. Call `verify_seed` for the initial criterion results.
4. Call `evaluate_criteria` for deterministic evaluation details.
5. Compare the seed with every prompt claim.
6. Correct each invalid reference or pre-satisfied positive criterion.
7. Repeat the checks after each correction.

See [`references/seed-fidelity-checklist.md`](./references/seed-fidelity-checklist.md) for the full checklist.
