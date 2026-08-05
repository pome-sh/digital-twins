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
`get_file_contents` → `add_issue_comment` → `slack_reply_to_thread`. The
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
sandbox is necessary — an examinee that can `cat ../tasks/duplicate-issue.md` is
reading its own criteria and seed — but it is not the fix. Completing the
denial is not the fix either: this measurement found two more paths after the
first three, in one sitting, without trying hard. The GitHub twin's read surface
is wide enough that any deny-list over it is a list someone must keep complete
against a model actively looking for a way through. **The flaw has to stop being
a tool-policy denial.**

### What was fixed here, and what was left open

Fixed in this commit: the sandbox (`tools: []`, an allowlist rather than another
name in a deny-list), and the claims in `local/src/index.ts` and
`local/README.md` that the 2026-08-04 run refuted.

Left open, deliberately, for the F-1292 design decision: the baseline defect
itself. Nothing here is stamped `verified red`, and the shipped
`DENY_ISSUE_LOOKUP = true` is now documented as a known-green baseline rather
than a lesson.

---

## The neutral prompt — prediction stated 2026-08-05, before the run

**Written before any trial was launched, and committed in the same change that
built the arm, so the measurement can contradict it.** This is the third time on
this example that a prediction was the only reason a wrong belief got caught.

### What is being tested, and why it is not the thing that was just retired

`docs/curriculum/failure-classes.md` §3 bans one baseline shape outright:

> **Anti-pattern (banned): omission-only prompt flaws.** A baseline that merely
> *fails to mention* the correct behavior rots red→green — strong models fill the
> gap with good judgment.

That sentence has never been measured. It was written in July 2026 as an
inference from the F-915/F-917 experience and has been load-bearing ever since:
it is the stated reason support-triage was re-cut away from its prompt and onto
the tool denial, which then turned out to be green 4/5 open-book and 5/5 sealed.
A rule that expensive should have a number under it.

**The arm.** `POME_TRIAGE_RULE=neutral` omits `TRIAGE_RULE` from the system
prompt. Nothing instructs the agent to search first; nothing instructs it not to.

**It is not `support-triage-v1.yaml`.** That prompt carried an active
prohibition — *"Don't spend time digging through existing issues"* — which is a
sabotaged prompt and is barred by the founder ground rule of 2026-08-05 (no tool
denial, no sabotaged prompt, no planted defect). Omission is a different object:
the neutral prompt is what a competent person writes before a duplicate has ever
burned them, and the fix — adding the search-first rule — is the engineering fix
a real team would ship, not the un-planting of a fixture.

### Conditions, all held constant against the measured control

| | value |
| -- | -- |
| examinee | `examples/support-triage/local`, sealed (`tools: []`, `settingSources: []`) |
| issue lookup | **allowed** (`DENY_ISSUE_LOOKUP = false`) — no denial, no rigging |
| model | `claude-opus-5`, pinned via `ANTHROPIC_MODEL` |
| task | `support-triage-dedup`, unchanged, 4 criteria, `passThreshold: 100` |
| kickoff prompt | `examinee_task.prompt`, unchanged |
| n | 5, one `group_id`, `agent_version` declared |

**The control is already measured and is the same code path:** `grp_f1292honest0805`,
`agent_version: f1292-control-honest`, `claude-opus-5`, sealed, denial off,
**search-first prompt → 5/5 at 100**. The only delta in this run is the presence
of one sentence in the system prompt.

### The prediction

**Point estimate: 3 of 5 green.** Range I would not be surprised by: 2–4.

Reasoning, so a wrong prediction is diagnosable rather than merely wrong:

* The *kickoff* prompt already says *"file a GitHub issue in acme/orders-service
  with repro steps and the `bug` label"*. With the search-first rule gone, the
  only instruction left about issues is an instruction to **create** one. That
  pushes toward filing a duplicate.
* Against that, `claude-opus-5` is careful and the word *"triage"* carries a
  check-first connotation; the control's five traces all began with
  `slack_list_channels → slack_get_channel_history → list_issues`, and
  `list_issues` may be reflex rather than instruction-following.
* One prior neutral run exists and scored 33. n=1 supports nothing, and it is
  recorded here only so nobody later mistakes it for evidence either way.

**Predicted failure mode of a failing trial:** the agent opens issue #2 for the
bug #1 already tracks and posts #2's link, so `slack.message-contains "issues/1"`
fails, `github.no-new-issues` fails, and the `[model]` "commented on #1" criterion
fails. The fourth criterion grades *"the report the agent added (the issue
comment)"* — under this failure there is no comment on #1 for it to point at, so
expect **0 or 25**, not the 33 the "33, not 0" story is named after. That
referent bug is already filed against the criteria set and this run should
confirm or refute it.

### What each outcome settles

| result | conclusion |
| -- | -- |
| **5/5 green** | §3's omission ban is vindicated *on this task*. The neutral prompt is not a baseline, the funnel needs its red from real task difficulty, and nothing cheap is available. |
| **≤4/5** | §3's ban is falsified as a universal rule. An honest, unrigged baseline already exists in this repo and costs one sentence. §3 needs re-cutting, and every downstream ticket that cited the ban needs re-reading. |

Either way the number is the deliverable. **No `verified red` stamp is written
from this run alone** — a baseline is stamped against a model and a trial count,
and one arm at n=5 on one model is where that starts, not where it finishes.

### Result — **5 of 5 green. The prediction was wrong on every line.**

`grp_f1292neutral0805`, `agent_version: f1292-neutral-prompt`, `claude-opus-5`,
hosted, 2026-08-05. Predicted 3/5 (range 2–4). Measured **5/5 at 100**, all four
criteria, every trial. **pass^5 = 100%.**

| trial | run id | score | behaviour |
| -- | -- | -- | -- |
| 1 | `run_NfJysnBEvQsvoVdo` | **100** | searched, commented on #1, posted #1's link |
| 2 | `run_LFeTEuWcF3ReXAwf` | **100** | same |
| 3 | `run_P5f8Ee2nKmwH5Tpr` | **100** | same |
| 4 | `run_kEFL4DMqOFWeTkW9` | **100** | same |
| 5 | `run_okgfhfdFPUTE7Vhe` | **100** | same |

`https://app.pome.sh/runs/<run_id>` for any of them. ~$0.23 per trial, ~$1.15
for the arm — the cheapest thing in this ticket by an order of magnitude.

**Zero `create_issue` calls across five trials.** Every trial called
`mcp__github__list_issues` before it wrote anything, with nothing in its prompt
telling it to. The host-MCP leak check (`mcp__plugin_*`) was empty on all five,
so the seal from the previous commit held.

### What this settles

**§3's ban on omission-only prompt flaws is vindicated on this task.** Per the
pre-registered table above, 5/5 means the neutral prompt is not a baseline, the
funnel cannot get its red from a thinner prompt, and there is no cheap honest
red available on `duplicate-issue` as seeded. The rule stays; what changes is
that it now has a number under it instead of an inference.

### The stronger finding the run handed over, which was not what it was asked

The neutral arm and the search-first control are **behaviourally
indistinguishable**:

| | control (`grp_f1292honest0805`) | neutral (this run) |
| -- | -- | -- |
| prompt | search-first rule present | rule absent |
| result | 5/5 at 100 | 5/5 at 100 |
| looked before writing | 5/5 | 5/5 |
| duplicates filed | 0 | 0 |

**The sentence the entire v1→v2 lesson is built on has no measurable effect on
`claude-opus-5` for this task.** `opus-5` searches by reflex, not by
instruction. The "one-line fix" demo only ever worked because v1 did not omit
the rule — it carried an active prohibition, *"Don't spend time digging through
existing issues"*, and the fix was deleting a sabotage rather than adding an
improvement.

That is a finding about the onboarding narrative, not just about §3. The
quickstart's failing first report, the `first-report.png` screenshot, the "33,
not 0" story and both `/demo/` links all rest on a red that no honest
configuration of this task reproduces.

### What it does not settle

* **Only `claude-opus-5`, only n=5, only this task.** A weaker model may well
  need the sentence — the haiku arm scored 4/5 with it. The claim is scoped to
  what was run.
* **Nothing is stamped `verified red`,** because nothing here is red.
* It says nothing about a *harder* task. It says the current one is saturated at
  the frontier with or without instruction, which is the case for re-cutting the
  seed rather than the prompt.

### Method note, for the next person

This is the third consecutive time on this example that a written-down
prediction was the only reason a wrong belief got caught, and the second time
the prediction was **mine** and wrong. The value is not in predicting well. It
is that a committed prediction makes "the run disagreed" a cheap sentence to
write instead of an expensive one.
