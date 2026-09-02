# Seed verification checklist

Use this checklist before you run a new task. Use it again after each seed or `[code]` criterion change.

## Inputs

- A complete task source or saved `task_id`.
- The task's configured twins.
- Access to the Pome control MCP for hosted verification.
- Optional sandbox access for a read-only probe.

## Output

Produce a verdict, a criterion table, state findings, and required corrections.

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

Every task needs at least one positive discriminator that fails on the seed. A crashed agent must not receive full credit.

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

## Apply schema checks

All five current seed schemas reject unknown top-level and entity keys. Explicit map and payload fields are exceptions.

Correct field spelling instead of relying on silent removal.

### GitHub

- Supply at least one repository.
- Keep issue and pull-request numbers unique within each repository.
- Seed every label before an issue references it.
- Include each assignee in the repository's collaborators.
- Author logins in seeded issue comments, pull requests, and reviews become users automatically.
- Seed the pull-request `head` branch with a file when that branch needs creation.
- Keep review-comment paths and lines within the pull-request change.

### Slack

- Use only `team`, `users`, `channels`, `files`, and `emoji` at the top level.
- Use valid Slack-style identifiers when you supply identifiers.
- Use lowercase channel names.
- Ensure that each message identifies a user.
- Ensure that channel member and message references resolve during twin loading.

### Stripe

- Use only `api_keys`, `failure_injection`, `payment_intents`, `charges`, `refunds`, and `balance_transactions`.
- Supply all required fields for seeded payment rows.
- Keep charge, refund, and balance references consistent.
- Use an HTTP status from `100` through `599` in a failure rule.
- Use a positive attempt number in a failure rule.

### Gmail

- Supply `primaryMailbox`.
- Keep all mailbox addresses unique.
- Use valid email addresses and date-time values.
- Use supported filter queries.
- Do not configure filter forwarding. The schema rejects it.
- Ensure that labels referenced by messages exist when the task depends on label identity.

### Linear

- Use uppercase team keys.
- Ensure that issue team references resolve.
- Ensure that assignee, creator, and delegate references resolve.
- Ensure that issue labels, projects, cycles, and states resolve.
- Ensure that comments reference a seeded issue.
- Use valid webhook URLs that satisfy the twin's network rules.

## Check multi-twin seeds

1. Confirm that the seed is an object keyed by configured twin identifiers.
2. Remove keys for twins that are not configured.
3. Validate each value against that twin's flat schema.
4. Remember that an omitted configured twin uses its default seed.
5. Confirm that each `[code]` criterion names its twin.

Do not infer the seed type from its fields. The `twins` configuration selects each schema.

## Use a read-only probe

Use a probe only when schema and deterministic checks cannot confirm the externally visible state.

1. Call `run_task` to create the live sandbox and receive launch data.
2. Do not launch the agent.
3. Store `agent_token` in a temporary process variable.
4. Send only read requests to URLs in `examinee_launch`.
5. Confirm only the state needed by the task.
6. Stop the sandbox after the probe.

Do not print, log, or save `agent_token`. Do not send a write request during a seed probe.

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
