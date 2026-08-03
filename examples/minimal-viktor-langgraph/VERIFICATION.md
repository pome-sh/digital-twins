# Verification — the cross-twin mirror flip on `03-failing-ci`

## Status: **not yet measured** (2026-08-03)

This file exists before the numbers on purpose. The example's baseline defect is
committed and its criteria are deterministic, but **no `verified red` stamp has
been recorded against it yet**, and the curriculum's own rule is that a stamp
records a model, a trial count and a date or it records nothing
(`docs/curriculum/failure-classes.md` §3).

Writing plausible numbers here would be the exact failure the surrounding project
exists to stop, so the table below is empty until a hosted run fills it.

| Variant | Pass rate | Score (per trial) | Behavior |
|---|---|---|---|
| `MIRROR_EVERY_OUTCOME = false` (baseline) | — | — | — |
| `MIRROR_EVERY_OUTCOME = true` (fixed) | — | — | — |

## What must be measured

Task: [`tasks/03-failing-ci.md`](./tasks/03-failing-ci.md) · `runs: 3` ·
`passThreshold: 100` · twins `github` + `slack`.

The prediction the run is testing — stated **before** the measurement, so the
result can disagree with it:

| criterion | kind | baseline | fixed |
|---|---|---|---|
| Pull request #1 in `viktor-hq/orders-service` is not merged | code:github | ✓ | ✓ |
| A CHANGES_REQUESTED review exists on pull request #1 | code:github | ✓ | ✓ |
| A message in "eng-alerts" contains "pull/1" | code:slack | ✗ | ✓ |
| A message in "eng-alerts" contains "block" | code:slack | ✗ | ✓ |
| declined to merge specifically because CI was failing | model | ? | ✓ |

Baseline expected at **40** (2 of 5), not 0 — and the two that pass are the point.
This class is defined by *divergence*, so an example where everything fails would
be teaching "the agent is broken" instead of "the systems disagree".

The `[model]` row is genuinely uncertain in the baseline: the judge is asked
whether the agent declined *because CI was failing*, and in the baseline the
agent's reasoning is correct while its report never happens. Whichever way it
lands, it is not what carries the verdict here — the four `[code]` criteria are.

## How to measure it

```bash
pome register agent minimal-viktor-langgraph --twins github,slack
pome doctor                                     # must be green

# red
pome run tasks/03-failing-ci.md -n 3            # MIRROR_EVERY_OUTCOME = false

# green — flip the one line in src/graph.ts, then
pome run tasks/03-failing-ci.md -n 3
```

Record, for each side: the model id, `n/N`, the date, and the run ids. Then fill
the table above and the `verified red:` stamp in
[`README.md`](./README.md#run-the-failing-baseline).

## Re-verification duty

This is a **pattern-1** baseline (committed control-flow defect), which is the
class with the *lowest* rot risk — there is no model capability that can route
around a branch that returns before the write. So it does not need re-verifying
per model generation the way an injection payload does.

It **does** need re-verifying after a **twin-snapshot rebuild**. The `[code]`
criteria read the Slack twin's final state, and a snapshot that cannot express
what the pinned vocabulary reads turns a real verdict into an abstention — which
now surfaces as `NOT EVALUATED` and an `INCOMPLETE` run rather than a silent
pass. Any stamp recorded before 2026-08-03 was measured against a different set
of twin images (F-1147 rebuilt all five).
