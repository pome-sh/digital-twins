---
name: pome-run-task
description: Runs a verified Pome task against the builder's examinee and scores it from the live twin tape — run_task to mint the session, launch the examinee on its runtime (Managed Agents via ant, or REST), finalize_run the instant it idles while the tape is still live, then narrate get_report; re-runs only the failed tasks after a prompt fix and shows the delta. Use when the user's task passed seed verification and they want to run the exam, asks "run my tasks / how did my agent do?", or wants to re-test after a prompt fix.
---

# Pome run task (Skill 4)

You are the **coach**: you talk to the builder and to the Pome control MCP
(`mcp.pome.sh`). The **examinee** is the sandbox clone Skill 0 (`pome-intake`)
registered, launched here for real against live twins. This skill runs one
already-verified task and scores it from the twin tape. Verify the seed
first (`pome-verify-seed`) — this skill does not re-check fairness.

Only **one** step here is examinee-runtime-specific: launching the examinee.
Minting, finalizing, scoring, reporting, and the fix loop are runtime-agnostic
(ADR-018). The launch **policy** — `always_allow`, closed-book web tools, memory
snapshot-clone, the network clamp — is owned by the `examinee_launch` spec, not
by this prose: you *execute* the spec, you do not restate it.

If the `mcp__pome__*` tools are missing, the MCP isn't connected: ask the user
to connect and authenticate it (interactive OAuth — needs a human in a browser)
instead of probing the endpoint.

**SENSITIVE — the bearer.** `run_task` returns `agent_token`, a
session-scoped JWT that is the bearer for every twin URL — a live credential.
Hold it in memory for this run only: never write it to disk, into a task, or
a log. It dies at `expires_at`; `finalize_run` is the last thing that needs it.

## 1. Mint the run

Mint a `grp_`-prefixed `group_id` **now** and reuse it for every trial of this
attempt — the baseline and any *pre-fix* flaky retries — so they aggregate as
one exam (aggregation keys on `(group_id, task)`; never reuse a `group_id`
across different tasks). A **post-fix** rerun is the exception: it opens a *new*
`group_id` and links back to the baseline via `baseline_group_id` (see §5).
Then call `run_task(task_id, agent_id, agent_version, group_id)` (the
`agent_id` from intake). It seeds live twin sandboxes and returns `session_id`,
`expires_at`, `agent_token`, `examinee_task` (the prompt + twins the examinee
sees — no criteria), and `examinee_launch` (the full launch spec).

**`agent_version` on every run.** Read it from the manifest's `agent.version`
(`pome.json`); if the builder declares none, ask for one before the first run
rather than sending nothing. It is the label the run declares itself to be, and
it is what keeps one version's trials from being averaged with another's — the
dashboard partitions run-sets by `(agent, task, agent_version)`. Never
auto-bump it: it changes when the builder changes the examinee (§5), and a
version that moves on its own would split one exam into two run-sets of one.

- **Trials-of-N (the batch form)** — when the task's `## Config` sets `runs: N`
  (a flakiness budget), don't hand-loop `run_task`: call
  `run_trials(n, task_id, agent_version, group_id)`, the batch form that
  provisions all N trials up front under one shared `group_id` and returns a
  `trials[]` array, each with its own `session_id` + `agent_token`. You still
  launch and `finalize_run` **each** trial (all N sandboxes share the quota —
  launch + finalize promptly to free slots). Pass-rate is judged here, not by
  the platform: once the trials finalize, `list_runs(group_id)` gives the
  cross-trial view — compute the fraction passed and compare it to the task's
  `passThreshold` (default 100%).
- **`twins not enabled` (HTTP 400)** — the agent's allowlist is missing a twin
  the task needs. Heal with one additive `register_agent(name, twins:[…])`
  (it merges, never removes — F-784), then re-run. Do not re-intake the scope.
- Everything the examinee needs is inside `examinee_launch`. Read the **Runtime**
  line from the intake report (or `examinee_launch.transport`) to pick the
  launcher below.

## 2. Launch the examinee (the one runtime-specific step)

Dispatch on the runtime and hand off to the matching launcher, which assembles
the examinee **faithfully from `examinee_launch`**, starts it on the kickoff
task, and watches for idle:

- **Claude managed agent** (`transport: "mcp"`) → Anthropic's Managed Agents
  cloud via the `ant` CLI. Recipe:
  [`references/launch-managed-agent.md`](references/launch-managed-agent.md).
- **Anything else** (`transport: "rest"`) → the REST path (`rest_urls` + `env`).
  Recipe: [`references/launch-rest.md`](references/launch-rest.md) — which
  **preflights the wiring** (config → twin reachable → routing → egress floor,
  the `pome doctor` checks) before it launches, so a mis-wired examinee never
  runs against a live API instead of the twin. Dispatch honestly — a non-Claude
  examinee on Managed Agents runs as Claude, testing nothing.

## 3. Finalize the instant it idles

The twin tape lives in the running session's sandbox. `finalize_run` captures
final state + events off the **still-live** twins; once the session leaves
`ready`/`running` the sandbox is torn down and the tape is gone — it errors, and
the run is unrecoverable. So the moment the launcher reports the examinee idle
(done / awaiting-input with no more tool calls coming), call
`finalize_run(session_id, agent_token, agent_model=<examinee model>)`
**immediately** — before any cleanup, before narrating anything. Pass
`agent_model` from the intake Model line (or whatever model the launcher
configured); it is required for the report — omit only if truly unknown
(the report Model column stays blank). It scores synchronously against the
pulled tape and returns `{ run_id, score, judge_model, dashboard_url }`.
One evaluation per run.

## 4. Narrate the report

`get_report(run_id)` returns the run markdown. Narrate, don't dump: the
**Score /100**, the criteria table (each row's **Kind** = `code`/`model`,
**Status** = passed/failed/unmatched, **Reason**), **Provenance** (a live
twin-pull run is `hosted` — say so, it means Pome watched the work, not the
agent self-reporting), and the dashboard link on `app.pome.sh`. An `unmatched`
criterion binds to no declared check, so it was never graded — that is an
authoring defect, not a failing grade. Route it back to `pome-author-task`,
which re-authors it from `list_checks` rather than rewording it.

## 5. Fix loop (re-run only what failed, show the delta)

A green run is done. On a failure, the report's `## Handoff (fix prompt)` section
is the driver: it names what the agent did wrong. Hand it to the builder, they
edit the **examinee's** prompt, then re-run.

**The one thing you never do: make the exam easier to pass.** Every fix goes into
the examinee's prompt — never into the task. Do not weaken or delete a criterion,
lower a `passThreshold`, loosen a `[code]` predicate, or edit/remove the seed or
its expected end-state to turn a red run green. That is the "vibe-coder" failure
DeepEval names — gaming the metric by rewriting the test instead of fixing the
work — and it silently destroys the exam: a task that no longer discriminates a
working agent from a broken one grades nothing, so a green it produces is
worthless. If a criterion is genuinely wrong (unfair, `unmatched`, or
mis-specified), that is **not** a fix-loop edit — stop the loop and route it back
to `pome-author-task` / `pome-verify-seed`, where any criterion or seed change is
re-verified as a fair exam before it counts. Then:

1. Re-run **only the failed tasks** as a **fresh run-set** — one `run_task` (or
   `run_trials` for a flaky task) each against the same `agent_id`. A post-fix
   rerun mints a **new** `group_id` (omit it and `run_trials` mints one) and
   passes the failing run's group_id as **`baseline_group_id`** — the report's
   `## Rerun after fixing` section pre-fills both. The rerun is its own run-set
   linked back to the baseline; the dashboard pairs them and shows the fail→green
   delta. Do **not** reuse the baseline's `group_id` — that merges baseline+green
   into one aggregate and destroys the split. (A *pre-fix* flaky retry — same
   examinee, no edit — still shares the group_id; only a post-fix rerun opens a
   new one and links back with `baseline_group_id`.)

   **Bump `agent_version` too, and say so to the builder.** The edited prompt is
   a different agent, so the rerun declares a different version — have the
   builder set it in `pome.json` (`agent.version`), or agree one with them and
   pass it. A fresh `group_id` alone is not enough: the reliability page also
   partitions the *implicit* run-set by declared version, and the verdict strip
   asserts "same agent, same prompt" over a run-set. Rerun the fix as `v1` and
   the platform is being told the failure and the fix are the same agent — the
   spread it then reports is the fix working, mislabelled as unreliability.
2. There is no delta field in the report — compute it: pull `get_report` for the
   baseline run and the rerun, diff the Status column per criterion, and report
   the flips (`"leaked to #general: failed → passed"`). Baseline and rerun are
   now separate groups paired by `baseline_group_id`; `list_runs(group_id)` gives
   each run-set's view.
3. Repeat until every re-run is green (or the builder accepts the behavior).
   Only failed tasks re-run; the green ones are not re-billed.

## Report

End with: the task name and `run_id`, **Score /100**, the criteria table
(criterion · kind · status · reason), provenance, and the `app.pome.sh` link. On
a fix-loop run, add the per-criterion delta and name the prompt edit that moved it.
