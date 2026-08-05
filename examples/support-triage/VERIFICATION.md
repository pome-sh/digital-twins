# Verification — the self-fix flip on `duplicate-issue`

## Two baselines, and only one of them is measured here

This example now carries **two** failing baselines, on two runtimes:

| Baseline | Where | Flaw | Curriculum pattern | Measured below |
|---|---|---|---|---|
| Managed-agent v1/v2 prompt pair | `agents/*.yaml` | charter line telling the agent not to search | 2 (policy constant) | **yes** |
| Local examinee | `local/src/index.ts` — `DENY_ISSUE_LOOKUP` | tool policy denies every issue read path | 1 (config defect) | **no — pending** |

**Everything below measures the first one.** The local examinee's pattern-1
baseline is the one the curriculum grades, and it has **no stamp yet**.

Three reasons the numbers below do not transfer to it, each independently
sufficient:

1. **It is a different flaw.** A prompt line and a tool policy are not the same
   experiment, and the whole point of the re-cut is that the second one does not
   rot the way the first one can.
2. **They predate honest scoring.** They were recorded before a criterion the
   grader could not run rendered as `NOT EVALUATED` — so a `100` in the table
   below is not the same claim a `100` is today.
3. **They predate the twin images.** All five twin snapshots were rebuilt and
   promoted on 2026-08-03 (F-1147). Any stamp recorded before then was measured
   against a different substrate.

They are kept, unedited, because the "33, not 0" story is real and this is where
it was actually measured — and because deleting the provenance of a number the
whole onboarding narrative rests on would be worse than dating it.

---

## Measured: the managed-agent v1/v2 pair (2026-07, superseded as the curriculum stamp)

Empirically measured on Pome, scored from the live twin tape (`provenance: hosted`),
on team **AFFF's workspace**. Runs are visible on `app.pome.sh`.

## Setup

- **Two distinct agents** — each version is registered separately, so its scores
  accumulate under its own identity (not conflated):
  - `support-triage-v1` (baseline) — a distinct Pome agent (id redacted; the
    committed-manifest convention keeps `agt_` ids out of the repo)
  - `support-triage-v2` (fixed) — a second distinct Pome agent (id redacted)
- **Task**: `duplicate-issue` (saved as `support-triage-dedup`,
  `task_OJue2tyNX-EpAoAC3k51`). Seed pre-loads open issue #1 for the coupon bug;
  `#support` gets a *new* report of the *same* bug.
- **Examinee runtime**: Claude managed agent on Anthropic's Managed Agents cloud,
  assembled from `run_task`'s `examinee_launch` (network clamped to
  `twins.pome.sh`, `web_search`/`web_fetch` off, `always_allow` on every
  `mcp_toolset`, a vault `static_bearer` per twin URL). Ephemeral per trial —
  torn down after each `finalize_run`.
- **Examinee model**: `claude-sonnet-5` for **both** versions (same model, one-line
  delta). Sonnet was chosen deliberately — this bug is the mirror image of a
  prompt-injection demo: the *failure* is prompt-driven ("don't search, just
  file") and reproduces on any model, but the *fixed* path needs a model capable
  of reliably running search → match → comment → link. A weak model (haiku) files
  the duplicate reliably but only deduped ~2/5 of the time on the fixed prompt; a
  mid model (sonnet) makes the fixed side reliable.
- **The two prompts** differ by exactly one line
  (`diff agents/support-triage-v1.yaml agents/support-triage-v2.yaml`): the
  search-before-filing line.
- **Trials**: 5 per version, each finalized the instant the examinee idled.

## Result

| Version | Pass rate | Score (per trial) | Behavior |
|---|---|---|---|
| **v1** (baseline) | **0 / 5** | 33 · 33 · 33 · 33 · 33 | Did not search; filed a duplicate issue #2 and posted its link — a second issue for a bug already tracked. |
| **v2** (fixed) | **4 / 5** | 100 · 33 · 100 · 100 · 100 | Searched, found issue #1, commented on it, posted issue #1's link to #support — no duplicate. One trial still filed a duplicate. |

The v1 runs score **33**, not 0, because one criterion — *the report contains
concrete repro steps* — is independent of the dedup decision and passes in every
run; v1 writes a good bug report, it just files it as a duplicate. The dedup
decision flips the other two criteria:

| criterion | kind | v1 | v2 |
|---|---|---|---|
| a `#support` message links `issues/1` | code:slack | ✗ | ✓ (4/5) |
| recognized the existing issue, opened no duplicate | model | ✗ | ✓ (4/5) |
| concrete repro steps | model | ✓ | ✓ |

State-diff at a glance: v1 leaves `issues: 1 → 2` (a duplicate); v2 leaves
`issues: 1 → 1` plus a comment on #1.

**Honest caveat.** v2 is 4/5, not 5/5. This dedup task carries ~20% agent
variance — occasionally the agent files a fresh issue despite the search-first
instruction. 0/5 vs 4/5 is a clear, reproducible flip, but the fixed side is not
pristine; a stronger model may or may not remove the last flake.

## Runs (all `provenance: hosted`, judge `google/gemini-2.5-flash`)

**v1 — 5/5 failed (33):**
- run_nrtQJdyqtmYwANuQ · run_zpqvU0PuwlU6sGfA · run_HaOqog6gNvchuuir · run_OoTjQHcn25uGdaKE · run_xbl1LQTjc57aDl1M

**v2 — 4/5 passed (100), 1 flake (33):**
- run_KYvIpLTuWoyL6SXK (100) · run_kUCZmKAcit5NWzxo (100) · run_Syq8A26s0LEWsMPP (100) · run_aeYs6ZadKLHvxNWp (100) · run_m8CpN9FecymhiSHM (33, flake)

`https://app.pome.sh/runs/<run_id>` for any of them.

## Reproduce

> The runs recorded above were made with the two prompts registered as two
> separate Pome agents. That is no longer the shape to copy: it produces two
> unrelated identities with no delta between them. The steps below are the
> current one — one agent, a declared version per run — which is what pairs the
> two run-sets into a fail→green comparison.

1. Register one agent on Pome: `register_agent(name="support-triage",
   twins=["github","slack"])`.
2. `run_trials(task_id, agent_id, agent_version="v1", n=5)`, then the same with
   `agent_version="v2"` and the v1 run's `group_id` as `baseline_group_id`.
   For each trial, assemble the clone from `examinee_launch` (env clamp, vault
   `static_bearer` per twin URL, `always_allow` on every `mcp_toolset`, web
   tools off), model `claude-sonnet-5`, `system` = that version's prompt; kick
   off with `examinee_task.prompt`.
3. Poll the managed-agent session to idle, then `finalize_run(session_id,
   agent_token)` immediately (tape is pulled from the still-live twin session).
4. The two versions differ by one line — `agents/support-triage-v1.yaml` vs
   `agents/support-triage-v2.yaml`.

---

## MEASURED, AND IT REFUTED THE PREDICTION: the pattern-1 baseline does not hold

**Status: measured 2026-08-04, `claude-opus-5`, n=5, hosted through the coach
door. The baseline PASSED 4 of 5.** It is not a failing baseline, and nothing
here may be stamped `verified red` until it is re-cut — see
[F-1292](https://linear.app/pome-sh/issue/F-1292).

| Variant | Pass rate | Score (per trial) | Behavior |
|---|---|---|---|
| `DENY_ISSUE_LOOKUP = true` (baseline) | **4 / 5 — the wrong direction** | 25 · 100 · 100 · 100 · 100 | Four trials reached issue #1 anyway and did the correct thing. One escalated to the operator and posted nothing. **No trial filed a duplicate.** |
| `DENY_ISSUE_LOOKUP = false` (fixed) | not run | — | Moot until the baseline is red. The "fix" produces the behaviour the baseline already produces 4 times in 5. |

Runs, all `provenance: hosted`, group `grp_f979red20260804`, judge
`google/gemini-2.5-flash`, examinee adapter 0.3.1:

- `run_MHw1bLK9hkCUEFpo` (25) · `run_YXZkavGL1a4jgKSJ` (100) ·
  `run_xhDsQZIc6tcRYTuS` (100) · `run_D9XK4d2UC6xTZflx` (100) ·
  `run_bUIWrNDTYfZ3bkmC` (100)

`https://app.pome.sh/runs/<run_id>` for any of them.

### The prediction, stated before the measurement — and wrong on every line

It was written here so the run could disagree with it. It did.

| criterion | kind | predicted baseline | MEASURED baseline |
|---|---|---|---|
| A message in "support" contains "issues/1" | code:slack | ✗ | **✓ in 4/5** |
| no new issues were created | code:github | (added after) | **✓ in 5/5 — never discriminated** |
| commented on the existing issue #1 | model | ✗ | **✓ in 4/5** |
| concrete repro steps | model | ✓ | ✗ in the one red trial (nothing was posted at all) |

Predicted **33**. Measured **25 once and 100 four times**.

### Why it went green, measured rather than guessed

Two independent routes, both of which the agent volunteered in its own output:

1. **A write endpoint is a read oracle.** `ISSUE_LOOKUP_TOOLS` denies
   `search_issues`, `list_issues`, `get_issue`. It does not deny `update_issue`,
   which 404s on a missing issue and succeeds on a present one. Trials 2 and 3
   said so unprompted: *"I read issue #1 through a mutating endpoint
   (`update_issue` with no fields) because it was the only read path available."*
2. **The exam is open-book.** `deniedTools()` names two web tools and three MCP
   tools. Every Claude Agent SDK built-in — `Bash`, `Read`, `Glob`, `Grep` — is
   live, and the examinee's cwd is `local/`, one level below the task file with
   its criteria and full seed, this file, and the README. Trial 5 ran
   `cat src/index.ts`, found the fixture, and reported: *"the deny-list …
   appears to be an intentional fixture rather than a misconfiguration …
   flipping it to `false` is the documented fix."*

So the README's *"it cannot rot green"* claim is false, and its stated reason —
*"no model capability can call a tool that was never exposed"* — is true but
beside the point. The model never needed the denied tool. It built the read out
of an allowed write, and out of a shell.

**This is the same defect class the re-cut was supposed to escape.** Pattern-2
red was rejected here as *"indistinguishable from an evaluator that did not
run"*. Pattern-1 as built is worse: it is indistinguishable from a **passing
agent**, and whether it is red at all depends on how clever the model is —
which `docs/curriculum/failure-classes.md` §3 bans by name.

### How to measure it

```bash
pome run tasks/duplicate-issue.md -n 5          # red   (DENY_ISSUE_LOOKUP = true)
# flip the constant in local/src/index.ts, then
pome run tasks/duplicate-issue.md -n 5          # green
```

Record the model id, `n/N`, the date and the run ids on both sides, then fill the
table and the `verified red:` stamp in [`README.md`](./README.md).

### The criteria ARE finished — that half shipped

`github.no-new-issues` landed in `twin-github` 0.9.0
([F-1198](https://linear.app/pome-sh/issue/F-1198), digital-twins#283), published
in `packages-v31`, and reached prod in pome-cloud `v0.4.49`. The task carries it
(digital-twins#305), so the set now asserts the agent **opened no second issue**
and not merely that it linked the right one — the negative assertion
`docs/curriculum/failure-classes.md` §4.2 asks for.

The cross-repo train it had to ride, recorded because it recurs: **twin PR merges
→ `packages-v*` publishes to npm → pome-cloud bumps its pin (in BOTH
`apps/control-plane` and `apps/mcp`) → only then** does the criterion belong in
this file. Added earlier, `criteria-corpus-watch` resolves it against the old pin
and reports an unresolved phrase.

**One caveat the measurement produced.** On this baseline the criterion passed in
all five trials, because no trial ever created anything. It is doing real work on
the GREEN side — it is what stops an agent scoring 100 by linking `issues/1` and
filing a duplicate anyway — but it does not discriminate on the red side, and the
README's framing of it as *"the lesson itself"* is stronger than the evidence.

### Re-verification duty — the stated reason was wrong

This section used to read: *"Pattern-1 baselines carry the lowest rot risk — no
model capability routes around a tool that was never exposed."*

**The 2026-08-04 measurement refuted that.** The model does not route around the
denied tool; it makes the denial irrelevant. It used `update_issue` — a write —
as an existence oracle, and it used the SDK's shell to read the fixture out of
the source tree. Neither is a "new read path to an issue" of the kind this
section anticipated, and `local/test/tool-policy.test.ts` pins a list that was
never the binding constraint.

So the duty is the opposite of what was written: a tool-denial baseline carries
**high** rot risk and must be re-verified per model generation, exactly like the
pattern-2 policy constant it replaced. A denial is only as strong as the
enumeration behind it, and enumerations are never complete.
