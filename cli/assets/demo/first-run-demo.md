# first-run-demo

<!--
The packaged `npx @pome-sh/cli demo` task. This markdown is the
CANONICAL source of the demo task content: the cloud's server-owned judge
definition (pome-cloud apps/control-plane/src/lib/demo.ts,
DEMO_TASK_DEFINITIONS["first-run-demo"]) mirrors this file — the judge scores
the server copy, never a client-supplied body, so the two must stay in
lockstep. Changing the prompt / expected behavior / criteria here without
updating the server definition means the cloud judges a different task than
the one the bundled agent ran.

MIRROR IT BY HAND. There is no generator and no gate — F-1752 is the ticket to
close that, and until it lands nothing but a reviewer notices a half-done sync.

The three tools the bundled demo agent exposes (src/demo/agent.ts) are the
contract this task is written against: list_open_issues, add_label,
comment_on_issue.

THE `[code]` ROWS ARE THE DEMO'S SCORE — keep at least one (F-1749). Since the
narrator flip took `[model]` out of the score denominator, a task declaring
only `[model]` criteria is not merely unscored: `total_required` is 0, the run
is not evaluable, and every trial of the advertised zero-auth door reports
"cloud could not evaluate the trace". Each `[code]` row must also be a sentence
the published check vocabulary renders — a hand-edited one binds nothing and is
the same empty denominator in different clothes. Both are asserted in
test/unit/demo/demo-task-criteria.test.ts, and that the bundled agent's correct
walk satisfies them in test/e2e/demo-e2e.test.ts.

Neither `[code]` row is true of the seed, which is what keeps them in the
denominator: the cloud drops a criterion the seed already satisfied
(`pre-satisfied.ts`), so a prohibition like "No new labels were created in
acme/api" would leave again and take the fraction with it.

The `[model]` rows stay because they are what the demo exists to SHOW — an
advisory narrative reading beside a deterministic fraction. They also carry the
two clauses no declared check can state, "and to no other issue" and "exactly
one comment", so dropping them would quietly narrow the task.
-->

## Prompt

You are triaging the acme/api repository. Find the open issue that reports a
500 error on POST /orders, apply the existing `bug` label to it, and leave
exactly one comment on that issue naming the failing endpoint and summarizing
the reported evidence for the maintainer. Use only the tools you are given.

## Expected Behavior

The agent lists the open issues, identifies the 500-error report among the
decoys, applies the existing `bug` label to exactly that issue, and leaves one
comment naming the failing endpoint (POST /orders) with the reported evidence
— without creating labels, inventing endpoints or ids, or touching any other
issue.

## Success Criteria

- [code] Issue #1 in `acme/api` has exactly one classification label, and it is `bug`
- [code] A comment containing "POST /orders" exists on issue #1 in `acme/api`
- [model] The existing `bug` label was applied to the issue reporting the 500 error on POST /orders, and to no other issue.
- [model] Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders).
- [model] No other issue was modified and no new label was created.

## Seed State

A GitHub-shaped twin seeded for issue triage (compiled sidecar:
`first-run-demo.seed.json` — hand-written, kept in lockstep with this prose).

### Repository: `acme/api`

A normal public repo, default branch `main`. `alice` and `bob` are
collaborators. Exactly three labels exist — `bug`, `feature`, `question` —
so the agent must pick one rather than invent one.

### Issues

Three open issues, none labeled, none assigned:

- **#1** `500 error on POST /orders after deploy` — "Started failing right
  after the 14:00 deploy. Stack trace points to OrderController#create."
  (the target)
- **#2** `Add CSV export for the orders dashboard` — a feature request
  (decoy)
- **#3** `How do we rotate the staging API keys?` — a question (decoy)

## Config

```yaml
twins: [github]
timeout: 60
passThreshold: 100
```
