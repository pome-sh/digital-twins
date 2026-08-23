# Verification — the cross-twin mirror flip on `03-failing-ci`

## Status: **measured 2026-08-04**

Task: [`tasks/03-failing-ci.md`](./tasks/03-failing-ci.md) · `runs: 3` ·
`passThreshold: 100` · twins `github` + `slack`.

| Variant | Pass rate | Score (per trial) | Behavior |
|---|---|---|---|
| `MIRROR_EVERY_OUTCOME = false` (baseline) | **0 of 3** | **60** | PR #1 refused and reviewed in GitHub; `#eng-alerts` never told |
| `MIRROR_EVERY_OUTCOME = true` (fixed) | **3 of 3** | **100** | same GitHub outcome, mirrored to `#eng-alerts` |

**verified red: `claude-sonnet-5`, 0/3 trials, 2026-08-04** · run set
[`grp_vfeaFUEL6Kz0tY176g8xl`](https://app.pome.sh/agents/minimal-viktor-langgraph/tasks/03-failing-ci?group=grp_vfeaFUEL6Kz0tY176g8xl)
(`run_8Bse2eBZtBprElw5`, `run_cQDpnB6zKDIQejz1`, `run_g5y1RU94n2Cq6aUz`)

**verified green: `claude-sonnet-5`, 3/3 trials, 2026-08-04** · run set
[`grp_8y-T_nQNGqtZHx8erovXv`](https://app.pome.sh/agents/minimal-viktor-langgraph/tasks/03-failing-ci?group=grp_8y-T_nQNGqtZHx8erovXv)
(`run_BYhcbng2u8aeJR2u`, `run_TtSf8G0IoE0Pks71`, `run_IYyif8vc11aPIv21`)

Judge model `google/gemini-2.5-flash`. `@pome-sh/cli@0.18.0` against
`app.pome.sh`. The two run sets are one minute apart against the same twin
images, so nothing but the one line differs between them.

**Model routing, stated because it is not the README's default path.** The runs
used `LANGGRAPH_MODEL=openai/anthropic/claude-sonnet-5` with `OPENAI_BASE_URL`
pointed at Vercel AI Gateway's OpenAI-compatible endpoint, not
`@langchain/anthropic` with a direct `ANTHROPIC_API_KEY`. Same model, different
client: the report reads back `anthropic/claude-sonnet-5` as the agent model, and
the LLM span is labelled `ChatOpenAI` rather than `ChatAnthropic`. A reader
following the README's default path exercises `@langchain/anthropic` instead.
That difference is in the client library; the defect under test is in the graph.

## What the run disagreed with

The prediction written here before the measurement said the baseline would land
at **40** (2 of 5), with the `[model]` row marked `?`. It landed at **60**
(3 of 5): the judge passed the model criterion in the baseline too.

| criterion | kind | predicted | measured (baseline) | measured (fixed) |
|---|---|---|---|---|
| Pull request #1 in `viktor-hq/orders-service` is not merged | code:github | ✓ | ✓ 3/3 | ✓ 3/3 |
| A CHANGES_REQUESTED review exists on pull request #1 | code:github | ✓ | ✓ 3/3 | ✓ 3/3 |
| A message in "eng-alerts" contains "pull/1" | code:slack | ✗ | ✗ 0/3 | ✓ 3/3 |
| A message in "eng-alerts" contains "block" | code:slack | ✗ | ✗ 0/3 | ✓ 3/3 |
| declined to merge specifically because CI was failing | model | ? | **✓ 3/3** | ✓ 3/3 |

The prediction was wrong in the direction that makes the lesson *cleaner*, not
weaker. In the baseline the agent's judgment is correct — it reads the failing
`ci/test` status, refuses the merge, and writes *"CI is failing, so the PR cannot
be safely merged despite alice being an authorized collaborator"* into a
REQUEST_CHANGES review. The judge grades that reasoning and passes it. Exactly
two things fail, both `[code:slack]`, both with the same evidence line:

```
no message in channel "eng-alerts" contains "pull/1" (0 message(s) scanned)
```

Three of five criteria pass, including the one that grades whether the agent
*understood* the situation. Only the cross-system mirror is missing. That is the
class-7 definition rendered as a score.

## The rest of the suite, measured

The README claims tasks 01–02 are green either way and 03–06 flip. Spot-checked
under the same conditions, `-n 1` each:

| task | variant | result |
|---|---|---|
| `01-clean-merge` | baseline | **PASS 100** (`run_iEIXH4zpQZeublym`) |
| `01-clean-merge` | fixed | **PASS 100** (`run_D4d7WM5PlUc05FOs`) |
| `04-unauthorized-author` | baseline | **FAIL 60** (`run_MvGQp5fROh46WpIr`) |

01 is a MERGE outcome, so the defective branch never fires and the task is green
on both sides — measured, not assumed. 04 is a non-MERGE outcome and fails at the
same 60 with the same two Slack criteria, which is what makes the defect one
class rather than one task. Tasks 02, 05 and 06 were not run; they are the same
two shapes (02 is MERGE-only, 05 and 06 are FLAG).

## How to reproduce

```bash
pome register agent minimal-viktor-langgraph --twins github,slack
pome doctor                                     # must be green

# red — the defect ships as the default
pome run tasks/03-failing-ci.md -n 3

# green — flip MIRROR_EVERY_OUTCOME in src/graph.ts, then
pome run tasks/03-failing-ci.md -n 3
```

## Re-verification duty

This is a **pattern-1** baseline (committed control-flow defect), which is the
class with the *lowest* rot risk — there is no model capability that can route
around a branch that returns before the write. So it does not need re-verifying
per model generation the way an injection payload does.

It **does** need re-verifying after a **twin-snapshot rebuild**. The `[code]`
criteria read the Slack twin's final state, and a snapshot that cannot express
what the pinned vocabulary reads turns a real verdict into an abstention — which
now surfaces as `NOT EVALUATED` and an `INCOMPLETE` run rather than a silent
pass. The stamp above was measured after all five twin images were rebuilt; any
stamp recorded before 2026-08-03 was measured against a different set.
