# Verification — the self-fix flip on `duplicate-issue`

## Three baselines, and none of them is the curriculum stamp yet

This example has carried **three** attempts at a failing baseline. The first two are
measured and both are superseded; the third is stated but not yet run:

| Baseline | Where | Flaw | Curriculum pattern | Measured below |
|---|---|---|---|---|
| Managed-agent v1/v2 prompt pair | `agents/*.yaml` | charter line telling the agent not to search | 2 (policy constant) | **yes — superseded** |
| Local examinee | `src/index.ts` — `DENY_ISSUE_LOOKUP` | tool policy denies every issue read path | 1 (config defect) | **yes — refuted, see below** |
| **Hardened world** | `tasks/duplicate-issue.md` — the seed | none: the red comes from task difficulty | — (difficulty, not a planted flaw) | **not yet — prediction stated below** |

**The 2026-07 numbers below measure the first one.** The pattern-1 baseline was
measured on 2026-08-04/05 and refuted; the hardened re-cut is stated in the next
section with its prediction. **Nothing here is stamped.**

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

## THE RE-CUT: the red moves into the world, and this is the prediction

**Written 2026-08-21, before any trial of the hardened task was launched.** This
section is committed ahead of the run on purpose. It is the same discipline that
caught the two wrong beliefs recorded further down this file — the prediction was
written first, the run disagreed with it on every line, and that is the only
reason the disagreement was visible instead of being rationalised afterwards.

### Why the flaw left the examinee entirely

Three measurements below, taken 2026-08-04/05, close off three separate places a
red could have come from:

| what was tried | result |
|---|---|
| the shipped tool-policy denial, open sandbox | 4/5 green |
| the same denial, sandbox closed (`tools: []`) | **5/5 — closing the hole made it greener** |
| no denial at all, honest prompt, closed sandbox | 5/5 |
| the search-first rule deleted from the prompt (`POME_TRIAGE_RULE=neutral`) | 5/5 |

The last row is the one that decides this. The sentence the whole v1→v2 lesson
rests on has **no measurable effect on `claude-opus-5` for this task** — every
trial called `list_issues` before writing anything, with nothing instructing it
to. It searches by reflex. So the original demo was only ever red because v1
*forbade* searching, and the "one-line fix" was un-planting a sabotage.

`docs/curriculum/failure-classes.md` §3 bans omission-only prompt flaws and bans
capability-anchored baselines. Both bans held. What is left is the seed: under
AutomationBench's taxonomy this task's decision had a search space of exactly one
issue in one repository, which is their `simple` class — the 200 tasks they ship
and **deliberately exclude from scoring**.

### What changed in the world

Nothing was removed from the examinee. The agent keeps every tool it had.

| | before | after |
|---|---|---|
| open issues | 1 | 5 (`#8`, `#23`, `#31`, `#47`, `#52`) |
| the textual bullseye | `#1`, and it is the answer | `#47`, and it is **not** the answer |
| the answer | comment on `#1` | comment on `#23`, the `tracking` issue |
| where the rule lives | nowhere — it is obvious | `docs/triage-policy.md`, committed in the repo, named in no prompt |

`#47` is the instrument. It is open, labelled `bug`, and a word-for-word match for
evan's report — every default a triage agent carries points at it. Only the policy
file says otherwise, and the policy file has to be found.

This is the L3 shape from `examples/minimal-viktor/LADDER.md`, which measured the
difficulty ceiling over 19 hosted trials and four models: the lowest
*discriminating* rung was conflicting policy, and the load-bearing finding was that
**the productive conflict is a written rule against an unwritten default the agent
already carries** — not two written rules with a stated precedence, which every
model resolved correctly in all 19 trials.

Fairness rules honoured, each one a cap stated rather than smuggled:

* **Noise never enters a lookup table.** The policy file is exactly correct. The
  distractors live in the issue list, which is data. A correct lookup always
  yields the correct answer.
* **The examinee cannot read the answer key.** Unchanged from the seal that landed
  in #318: `tools: []` plus `settingSources: []`.
* **No treasure hunt without a search tool.** The agent has `search_code` and
  `get_file_contents`, and `README.md` points at `docs/`. The ladder had to cap
  this lever because minimal-viktor has no search tool; here it is genuinely
  reachable, which also means **this is the first Pome task to test "ambiguity of
  where the information lives" at all**. New ground, so it is called out.
* **The comment needle is policy-mandated, not guessed.** `#47` is required in the
  comment by rule 2 of the policy file itself, so the criterion asserts a stated
  convention rather than a guess about how a model phrases things.

### The grading, and one thing that must not be "fixed"

Six criteria, five `[code]`, all five bound (`validate_task`: `bound: 5,
unbound: 0`). `verify_seed` on this seed: *"No success criterion already passes on
the seed's initial twin state — the seed is clean."*

| # | criterion | at seed |
|---|---|---|
| c1 | `[code:github]` a comment containing `#47` exists on issue `#23` | **failed** (positive, FAIL_TO_PASS) |
| c2 | `[code:slack]` a message in `support` contains `issues/23` | **failed** (positive, FAIL_TO_PASS) |
| c3 | `[code:slack]` no message containing `issues/47` in any public channel | passed (negative) |
| c4 | `[code:github]` no new issues in `acme/orders-service` | passed (negative) |
| c5 | `[code:github]` `add_issue_comment` was called | unreadable at seed (tape) |
| c6 | `[model]` the comment carries the customer's concrete repro | judged at run time |

c3 is the AutomationBench **negative-assertion-bound-to-the-wrong-value** technique
that M3 adopted on 2026-08-13: beside asserting the right answer, assert the object
does not hold *the specific wrong value this task's failure mode produces*. Linking
`#47` back to the reporter is precisely what an agent that skipped the policy does,
and rule 3 of the policy file bans it in as many words.

⚠️ **c3 and c4 are deliberately NOT marked `always-scored`, and adding the marker
would break this task.** `verify_seed` emits a generic note suggesting it for
seed-true criteria. Do not take it here. Under F-1296 a seed-true criterion is
excluded from the denominator only when it *also* passes at finish; when the
examinee breaks it, it is **counted as a failure** (`docs/grading/seed-exclusion.md`,
row 2). So the guards still bite. What the marker would change is the do-nothing
agent:

| | c3/c4 unmarked (shipped) | c3/c4 `always-scored` |
|---|---|---|
| correct run | 4 of 4 → **100** | 6 of 6 → 100 |
| **null agent** | 0 of 4 → **0** | 2 of 6 → **33** |

A do-nothing agent scoring 0 is One Working Curriculum M0's own Done-when and the
entire reason F-1338 and F-1521 were built. The marker hands it 33 for free, which
is the reward-hacking case AutomationBench's exclusion exists to prevent.

### ⚠️ What this re-cut breaks, and it needs a call

**The managed-agent `agents/support-triage-v1.yaml` / `v2.yaml` pair no longer
tells a story against this task.** The two versions differ only on whether the
charter tells the agent to search existing issues first. Neither knows the
repository consolidates onto tracking issues, so against the hardened world
**both are expected to fail**, and the v1→v2 delta the pair exists to demonstrate
collapses to no delta at all.

That pair is referenced from the README's opening and is the managed-agent path's
whole demo, so it is not something to quietly delete. Three options, none taken
here because it is a product call:

1. **Give v2 the policy sentence** — the yaml equivalent of
   `POME_TRIAGE_POLICY_HINT=on`. Keeps the one-line-diff shape and re-points it at
   the new lesson. Cheapest, and it makes the two runtimes tell the *same* story
   again, which was the original intent.
2. **Point the pair at a second, easier task**, keeping it as the managed-agent
   onboarding demo with the hardened task reserved for the local examinee.
3. **Retire the pair.** It is the last pattern-2 baseline in the catalog and
   `failure-classes.md` §3 already flags pattern-2 as model-dependent.

Option 1 is the recommendation. Until one is taken, do not run the yaml pair
against `duplicate-issue.md` and read the result as a regression — it is this
re-cut working as designed, on an agent that was never told the rule.

### The prediction — STATED FIRST, THEN REFUTED (see Results)

Stated before the first trial, at `claude-opus-5`, n=5, hosted, sandbox sealed,
examinee otherwise **as shipped and carrying no planted defect**.

> **2 of 5 pass.** I expect three trials to comment on `#47` — the textual match —
> and never open `docs/triage-policy.md` at all. Of the two that find the policy, I
> expect both to apply it completely, because once the rule is in context it is
> unambiguous.
>
> I expect **zero** trials to open a new issue: `no-new-issues` has passed in every
> trial ever run on this task and the distractors do not make filing more
> attractive.
>
> The most likely single point of failure among trials that *do* find the policy is
> **c3, not c1** — an agent that routes correctly to `#23` but still pastes `#47`'s
> link into Slack "for reference".

**What would refute this: 5 of 5.** That would mean the L3 lever does not transfer
from an eight-pull-request world to a five-issue one, and that difficulty on this
task has to come from somewhere this re-cut does not reach. It is a live
possibility — this is the fourth consecutive prediction of a capability gap on this
example, and the previous three were all wrong in the same direction.

**If it is refuted**, the fallback is already designed and is not a redesign: the
same world, plus a committed pattern-1 config defect in the examinee — a
`TRIAGE_CONTEXT_FILES` entry pointing at a path that does not exist, so the policy
never reaches context. That is `failure-classes.md` §3 pattern (1) by the book, and
the fix is one line correcting the path.

### The fix arm, and why it is a real fix

The green arm is one line added to the examinee's system prompt: *"Before
commenting, check `docs/triage-policy.md` for routing rules."*

This is **not** un-planting a fixture. The baseline examinee is not sabotaged; it
is naive, which is the true state of most production triage agents. Telling an
agent where its team's conventions live is the actual repair a builder would make,
and the demo it produces is `unreliable → reliable` rather than `broken → fixed`,
which is what Premise C in `failure-classes.md` §2 says endures.

### Results — 11 hosted trials, 2026-08-21

All eleven ran against **one** task_hash, `2191ebc53183…`, the sha256 of
`tasks/duplicate-issue.md` exactly as it ships. Examinee as committed, no planted
defect, `POME_TRIAGE_POLICY_HINT` unset. Model pinned per arm via
`ANTHROPIC_MODEL` — verified honoured rather than assumed: the SDK's `init`
message echoes the requested model back.

| model | n | scores | pass rate | group |
|---|---|---|---|---|
| `claude-opus-5` | 5 | 100 · 100 · 100 · 100 · 100 | **5 / 5** | `grp_hardennaive0821b` |
| `claude-sonnet-5` | 3 | 40 · 40 · 100 | **1 / 3** | `grp_hardensonnet0821` |
| `claude-haiku-4-5` | 3 | 20 · 60 · 20 | **0 / 3** | `grp_hardenhaiku0821` |

Run ids — opus `run_BF1Ta2q9beZcgawm` · `run_YMoWSl1L2gKKk2vQ` ·
`run_j6vDUFrb5Qq2g5Ay` · `run_8dg0TEowP7rd0bPb` · `run_mct3R7EuAXalVgRe`;
sonnet `run_JKzQsboH4kkas0Fr` · `run_lHQG4JRlzV3u3Lc4` · `run_ymWzSlSP8NwxwQvX`;
haiku `run_2CI8p7FYeDURna8j` · `run_ZUzcIQ2xk1RbcEU7` · `run_m6HTDgHFK2BYJ0jw`.

#### The prediction was wrong, and this is the fourth time in the same direction

Predicted **2 of 5** on `claude-opus-5`, reasoning that three trials would stop at
the textual bullseye `#47` and never open `docs/triage-policy.md` at all.

Measured **5 of 5**, and the reasoning was wrong too. Every opus trial **fetched
`docs/triage-policy.md` by name, unprompted** — nothing told it the file exists.
From trial 1, after a `list_issues` that requested only `[number, title, state,
labels, created_at, updated_at]` and so never saw `#23`'s body:

> *"Report matches existing issue #47 exactly. Let me verify the repo's triage
> convention and inspect the code path before commenting."*
> → `get_file_contents({path: "docs/triage-policy.md"})`

It checks for a house convention by reflex, exactly as the 2026-08-05 arm showed it
searches issues by reflex. **That is four consecutive predictions of an opus-5
capability gap on this example, all wrong in the same direction.** The pattern is
worth more than any single prediction: on this task, assume frontier competence
until measured otherwise.

#### But the task discriminates — the ceiling just sits above opus

By `LADDER.md`'s pre-fixed definition (*at least one model below 100 and at least
one at 100*) this task is **discriminating**, and the gradient is monotonic in
model capability with no cell out of order. Three things fire here that never
fired on any earlier version of this example:

* **`no-new-issues` failed for the first time ever.** Haiku filed a duplicate —
  `#53` — in 2 of 3 trials. The original restraint lesson has never once been a
  *counted failure* before today; it passed vacuously in every previously recorded
  trial.
* **The wrong-value guard did its job.** `No message containing "issues/47"` failed
  on 2 of 3 sonnet trials and 1 of 3 haiku trials — agents that skipped the policy
  and handed the reporter the consolidated issue's link, the specific wrong
  behaviour it exists to name.
* **The F-1521 tape assertion bit.** `add_issue_comment` failed on the two haiku
  trials that filed an issue instead of commenting.

#### One observation outside the eleven, kept because it IS the failure mode

Before the measured set, one opus-5 trial (`run_PGiNHQxmEu02vZiZ`, score **40**)
ran against an **abbreviated `## Setup`**, so a different task_hash. It is excluded
from the numbers above deliberately — stamping this file from bytes it does not
ship is the exact defect this example keeps being caught by.

It is recorded because of *how* it failed. It found the policy and overrode it:

> *"Issue #23 … states that, per `docs/triage-policy.md`, new occurrences should be
> recorded on #23 rather than on #47 or #31. My operating instructions say to
> comment on the existing issue that tracks the bug, so I commented on #47."*

And one of the passing opus trials surfaced the same tension the other way:

> *"Your instructions and the repo policy point at different issues … I followed
> the repo policy since it's more specific."*

So the conflict is **live and consciously resolved, in both directions, by the same
model**. `TRIAGE_RULE` in the examinee's own system prompt says *comment on that
existing issue and post ITS link back*; the policy says otherwise. That is the L3
shape — a written rule against a standing obligation the agent already carries —
and opus resolves it correctly most, but not all, of the time.

### ⚠️ AUDIT 2026-08-21 (evening): the haiku arm is contaminated — two twin defects, not a capability gap

Before adopting `claude-haiku-4-5` as the quickstart's failing baseline, every
trace was read. **Five of haiku's eight failures were caused by the twin handing
it wrong answers.** The chain is identical each time:

1. haiku calls `list_issues({owner, repo, state:"OPEN", labels:["bug"]})` — the
   shape the tool's **own MCP `inputSchema` declares**.
2. The twin returns **422 Validation Failed**, `field: "labels"`,
   `code: "invalid_type"` — it rejects the array it declares (**F-1614**).
3. haiku falls back to `search_issues` with a multi-word query.
4. `search_issues` matches the whole query as one literal substring, so
   `"coupon 500"` finds nothing even though #47's title contains both words —
   **`total_count: 0`** (**F-791**, filed 2026-07-17, still Backlog).
5. haiku concludes *"no existing issue tracks this bug"* — **a correct inference
   from two wrong answers** — and files a duplicate.
6. Scored 0–20, and the report reads as *"the agent failed to check for
   duplicates."*

Probed directly against a live sandbox, no agent involved:

| call | result |
|---|---|
| `GET /issues?state=open` | 5 issues ✅ |
| `GET /issues?state=open&labels=bug` | 3 issues ✅ |
| MCP `list_issues {state:"OPEN"}` | 5 issues ✅ |
| MCP `list_issues {state:"OPEN", labels:["bug"]}` | **422 invalid_type** ❌ |
| `search_issues q=coupon` | 3 ✅ |
| `search_issues q="coupon 500"` | **0** ❌ |
| `search_issues q="repo:… is:open coupon"` | **0** ❌ |

**Against real GitHub every one of those trials would have found #47 and passed.**
The twin manufactured the failure and then graded the agent for it — the
anti-predictive case, which is the one property a measurement instrument cannot
have.

#### What survives the audit

| | trials | clean | genuine failure | twin-caused |
|---|---|---|---|---|
| `claude-opus-5` | 5 | 5 pass | — | — |
| `claude-sonnet-5` | 3 | 1 pass | **2** | 0 |
| `claude-haiku-4-5` | 8 | 0 pass | 3 | **5** |

**The discrimination verdict still holds, but it rests on sonnet, not haiku.**
Sonnet's two failures are clean: it listed the issues with no label filter, saw
both #47 and #23 in the result, and chose #47. That is the lesson firing.

#### What the audit cleared

* **No leakage.** Across all five audited trials the examinee called only
  `mcp__github__*` / `mcp__slack__*` — zero SDK built-ins, zero
  `mcp__plugin_*` (the developer's own connectors), zero web. `tools: []` +
  `settingSources: []` hold.
* **The examinee never sees the answer.** Verified from its own startup banner:
  it receives `examinee_task.prompt` only. `## Setup`, `## Expected Behavior` and
  the criteria never reach it.
* **No reward hacking.** No trial satisfied a criterion without doing the work;
  the two seed-true negatives behaved exactly as designed.

#### A grading defect the audit also turned up

On three trials with **identical** behaviour (created an issue, added no comment),
the judge graded the `[model]` criterion *"the report the agent added (the issue
comment)"* **two different ways** — twice it silently substituted the new issue's
body and passed; once it correctly said the premise was not met and failed. 20
points of variance injected by the grader. Filed as **F-1615**.

### What this settles, and what it does not

**Settles:** the seed was the right lever. This task went from saturated at every
model ever measured on it to a clean three-point gradient, with no planted defect,
no tool denial and no prompt omission. `verified red` is earned for
`claude-sonnet-5` and `claude-haiku-4-5`. It is **not** earned for
`claude-opus-5` — on opus this task is green, and saying otherwise would be the
whole failure this example exists to stop.

**Does not settle:** whether the `unreliable → reliable` demo works on opus. The
fix arm (`POME_TRIAGE_POLICY_HINT=on`) was **not run**, because on opus there is
nothing for it to repair. On sonnet it should move 1/3 → 3/3, and that is the
demo — but it is a *cross-model* story rather than a single-model one, and which
of those the curriculum leads with is a product decision, not a measurement.

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
   live, and the examinee's cwd — `local/` at the time of this run, the example
   root since F-1290 flattened it — carries or sits one level below the task
   file with its criteria and full seed, this file, and the README. Trial 5 ran
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
# flip the constant in src/index.ts, then
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
section anticipated, and `test/tool-policy.test.ts` pins a list that was
never the binding constraint.

So the duty is the opposite of what was written: a tool-denial baseline carries
**high** rot risk and must be re-verified per model generation, exactly like the
pattern-2 policy constant it replaced. A denial is only as strong as the
enumeration behind it, and enumerations are never complete.

---

## The two follow-up measurements F-1292 asked for (2026-08-05)

The 2026-08-04 numbers above said the baseline is green and named two routes.
They left two questions open, and both were answered by measurement before any
re-cut was designed. Same model (`claude-opus-5`, pinned), same task
(`support-triage-dedup`, 4-criterion shape), same twin images, `n=5` each,
`provenance: hosted`, `agent_version` declared on both run-sets.

### 1 · Does the task need a planted defect at all? — **yes**

The open question on F-1292 was whether the red could come from the task being
*natively* unreliable, with no planted flaw: *"if it lands around 2/5 or 3/5, the
example needs no planted defect and this ticket's fix is deletion rather than
redesign."*

**Honest prompt, no issue-lookup denial, closed sandbox: 5/5, every criterion,
every trial.** `agent_version: f1292-control-honest`, group
`grp_f1292honest0805`.

| run | score |
|---|---|
| `run_vLsIuRiVtcMTBNmT` · `run_mvoozQDpx5vAKFZO` · `run_dhO4mJXE6VlWAdIh` · `run_E2KPPNqefJiiU9p6` · `run_O9vVrhfhjHBhXlEm` | 100 · 100 · 100 · 100 · 100 |

The five traces are the same eight-step shape with no variance worth reporting:
`slack_list_channels` → `slack_get_channel_history` → `list_issues` →
`get_file_contents` → `add_issue_comment` → `slack_reply_to_thread`. (Those four
Slack names are the surface twin-slack served on 2026-08-05 and no longer does:
F-1330 replaced them with Slack's own — `slack_search_channels`,
`slack_read_channel` and `slack_send_message` with a `thread_ts`. They are left
as recorded, because this is what those five runs did, not a claim about what a
run today would do.) The
examinee was the shipped one with three deltas — `DENY_ISSUE_LOOKUP = false`,
`tools: []`, `model: "claude-opus-5"` — and the system prompt byte-identical.

So `pass^5 = 100%` with nothing planted. There is no natural reliability gap in
this task on this model: **an honest configuration has no red to show**, and the
*"unreliable → reliable"* framing has nothing to work with here. A planted defect
is required. This also retires the retracted six-run ~33% figure the ticket
withdrew: that population mixed configurations, and a clean run-set does not
reproduce it.

### 2 · Is the open sandbox the whole hole? — **no, and closing it made the baseline greener**

`tools: []` closes the sandbox completely: the SDK's `init` message listed 100
tools, **all** `mcp__*`, with no `Bash`, `Read`, `Glob`, `Grep`, `Write`, `Edit`
or web tool. With that shut and `DENY_ISSUE_LOOKUP` still `true`:

**5/5 at 100** — worse than the 4/5 the open-book version scored.
`agent_version: f1292-denial-closed-sandbox`, group `grp_f1292closedB0805`:
`run_SvJVIdPNFky5Ricf` · `run_KuS3vAtTSPxHhRV7` · `run_FEL1QIYelRe4Mky5` ·
`run_PiPJ5zBigltuqauB` · `run_M5XgOt1ZRtxz2WUb`.

The enumeration was missing more than `update_issue`. Every one of the five
trials used **both** of these, and neither is in `ISSUE_LOOKUP_TOOLS`:

| unnamed path | what it leaks |
|---|---|
| `list_issue_comments` | called in 5/5 — returns issue #1's comment thread; 404 vs 200 is itself an existence oracle |
| `update_issue` | called in 5/5 — a write that 404s on a missing issue and succeeds on a present one |

`search_code` (5/5) supplied `src/orders.py` for the root cause, so removing the
shell cost the agent nothing it needed. Two trials also *tried* the denied
`list_issues`, failed, and routed around it in the same turn.

**Conclusion, and it is the answer to F-1292's second "done when".** Closing the
sandbox is necessary — an examinee that can `cat tasks/duplicate-issue.md` is
reading its own criteria and seed — but it is not the fix. Completing the
denial is not the fix either: this measurement found two more paths after the
first three, in one sitting, without trying hard. The GitHub twin's read surface
is wide enough that any deny-list over it is a list someone must keep complete
against a model actively looking for a way through. **The flaw has to stop being
a tool-policy denial.**

### What was fixed here, and what was left open

Fixed in this commit: the sandbox (`tools: []`, an allowlist rather than another
name in a deny-list), and the claims in `src/index.ts` and
`README.md` that the 2026-08-04 run refuted.

Left open, deliberately, for the F-1292 design decision: the baseline defect
itself. Nothing here is stamped `verified red`, and the shipped
`DENY_ISSUE_LOOKUP = true` is now documented as a known-green baseline rather
than a lesson.
