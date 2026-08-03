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

## Pending: the local examinee's pattern-1 baseline

**Status: not yet measured** (2026-08-03). Deliberately empty — writing plausible
numbers here is the exact failure the surrounding project exists to stop.

| Variant | Pass rate | Score (per trial) | Behavior |
|---|---|---|---|
| `DENY_ISSUE_LOOKUP = true` (baseline) | — | — | — |
| `DENY_ISSUE_LOOKUP = false` (fixed) | — | — | — |

### The prediction, stated before the measurement

So the run can disagree with it.

| criterion | kind | baseline | fixed |
|---|---|---|---|
| A message in "support" contains "issues/1" | code:slack | ✗ | ✓ |
| recognized the existing issue, opened no duplicate | model | ✗ | ✓ |
| concrete repro steps | model | ✓ | ✓ |

Baseline expected at **33**, for the same reason the managed-agent v1 scored 33
and not 0: the agent does real work and its report is good. What it cannot do is
look.

### How to measure it

```bash
pome run tasks/duplicate-issue.md -n 5          # red   (DENY_ISSUE_LOOKUP = true)
# flip the constant in local/src/index.ts, then
pome run tasks/duplicate-issue.md -n 5          # green
```

Record the model id, `n/N`, the date and the run ids on both sides, then fill the
table and the `verified red:` stamp in [`README.md`](./README.md).

### The criteria are not finished

The set above asserts that the agent **linked the right issue**. It does not
assert that it **opened no second one** — the negative assertion
`docs/curriculum/failure-classes.md` §4.2 asks for, and the one this example's
lesson is actually named after. The declared GitHub vocabulary could not express
it until `github.no-new-issues` ([F-1198](https://linear.app/pome-sh/issue/F-1198),
digital-twins#283).

Sequencing, because it is a cross-repo train and getting it wrong reddens the
corpus gate: **twin-github 0.9.0 merges → publishes to npm → pome-cloud bumps its
pin → only then** does a `no-new-issues` criterion belong in this task file. Added
earlier, `criteria-corpus-watch` resolves it against the old pin and reports an
unresolved phrase.

### Re-verification duty

Pattern-1 baselines carry the lowest rot risk — no model capability routes around
a tool that was never exposed — so this does not need re-verifying per model
generation. It **does** need re-verifying when the GitHub twin's tool surface
changes: a new read path to an issue that `ISSUE_LOOKUP_TOOLS` does not name is a
way around the defect, and the baseline would go green for the wrong reason.
`local/test/tool-policy.test.ts` pins the list; it cannot know about a tool that
does not exist yet.
