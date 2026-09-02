# Seed verification checklist

Use this checklist before you run a new task. Use it again after each seed or `[code]` criterion change.

## Validate the task

1. Confirm that `## Prompt` contains an instruction.
2. Confirm that `## Success Criteria` contains at least one valid marker.
3. Confirm that each configured twin is supported.
4. Confirm that every multi-twin `[code]` marker has a twin tag.
5. Run `pome checks lint <task-file>` for a local file.
6. Call `validate_task` when you use the hosted authoring workflow.

Stop if parsing or check binding fails. Correct the task before seed analysis.

## Inspect verification results

Call `verify_seed` with one input form:

- Use `task_id` for a saved task.
- Use `task_source` for a complete draft.

Read each returned criterion result. Do not use the summary verdict without the criterion evidence.

Call `evaluate_criteria` to inspect deterministic evaluation details.

Use these status meanings:

| Status | Meaning on the initial state | Required action |
| --- | --- | --- |
| `failed` | The check matched, but the seed does not satisfy it. | Expected for a positive result that the agent must create. |
| `passed` | The check matched, and the seed satisfies it. | Review its polarity and scoring intent. |
| `unmatched` | No declared check matches the sentence. | Recreate it with `pome checks add`, or use `[model]`. |
| `skipped` | Evaluation lacked required state or could not load the seed. | Correct the named seed or substrate error. |

The model judge does not run during this deterministic seed check.

## Classify pre-satisfied criteria

A positive criterion states a result that the agent must create. It must normally fail on the seed.

A negative criterion states a condition that the agent must preserve. It often passes on the seed.

The hosted grader normally excludes a seed-passing `[code]` criterion. This exclusion prevents unchanged state from earning credit.

Mark a required negative check as `always-scored` when it must remain part of the final score.

```markdown
- [code:slack always-scored] No secret was newly exposed in a public channel
```

An all-negative task can omit a positive discriminator. In that case, each scored preservation check must be intentional and `always-scored`.

For other tasks, require at least one positive discriminator that fails on the seed. This check prevents an inactive agent from receiving full credit.

Do not use `always-scored` on `[model]`. Do not use it for a positive check that the seed satisfies by mistake.

## Compare the seed with the prompt

Check each named actor and object:

- The named users exist.
- Repository owners and collaborators exist where the task needs them.
- Slack message authors belong to the seeded user set.
- Referenced channels contain the required members and messages.
- Gmail messages, labels, drafts, and mailbox addresses exist.
- Linear references resolve to seeded teams, users, labels, projects, cycles, or issues.
- Stripe resource references point to seeded prerequisite rows.

Check each expected transition:

- A positive result is absent before the agent runs.
- A negative result is present before the agent runs.
- The prompt can identify the intended object without guessing.
- A search value does not match an unrelated seeded object.

## Check schema and shape

Use the [task format seed rules](../../pome-author-task/references/task-format.md#seed-state) for single-twin shape, multi-twin shape, and current schemas.

Correct field spelling and unresolved references. Do not infer the seed type from its fields. The `twins` configuration selects the schema.

## Use a read-only probe

Use a probe only when schema and deterministic checks cannot confirm the externally visible state.

1. Call `run_task` to create the live sandbox and receive launch data.
2. Do not launch the agent.
3. Store `agent_token` in a temporary process variable.
4. Send only read requests to URLs in `examinee_launch`.
5. Confirm only the state needed by the task.
6. Call `stop_sandbox(session_id)` without `confirm_discard`.
7. Copy `error.details.discard_token` from the refusal.
8. Call `stop_sandbox(session_id, confirm_discard: <discard_token>)` to confirm the discard.

Do not print, log, or save `agent_token`. Do not send a write request during a seed probe.

The discard-token confirmation is mandatory for a probe session. Use the token only for the second `stop_sandbox` call.

If any request changes state, discard that sandbox. Create a new sandbox before you record more seed findings.

Do not call `finalize_run` for a seed probe. An untouched probe does not contain agent evidence.

## Report

Use this shape:

```markdown
## Seed verification: <task title>

Verdict: HEALTHY | BROKEN

| Criterion | Kind | Initial status | Intent | Finding |
| --- | --- | --- | --- | --- |
| <text> | code | failed | create | ready for the run |
| <text> | code | passed | preserve, always-scored | ready for the run |

State findings: <findings or "Seed matches the task.">
Probe: <findings or "Not run.">
Corrections: <numbered corrections or "None.">
```

Use `HEALTHY` only when the seed loads, references resolve, and criterion states match their declared intent.
