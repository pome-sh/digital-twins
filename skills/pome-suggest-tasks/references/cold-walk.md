# M2 cold walk — registration → first own-agent report

The one-session journey `pome-suggest-tasks` fronts. Each step lists **input ·
what the coach does · expected artifact**. The two human checkpoints are marked
⚑; every other step is automatic on the happy path. A step stops for the builder
ONLY on the failure named in its row — no founder rescue otherwise (Done-when #3).

1. **Registration** (upstream — F-858, not this skill)
   - Input: a foreign repo with the agent's code.
   - Coach: confirm the agent is registered via the **CLI** — a local repo, so
     `pome register agent`, **not** MCP `register_agent` (see the pome router's
     "One register verb"): a `pome.json` (with `twins`) and a populated
     `.pome/link.json` are present. This skill only verifies the manifest is
     there and enters the chain.
   - Artifact: `pome.json` + `.pome/link.json` at the repo root; an `agent_id`
     on the platform.
   - Stops if: no `pome.json` → route back to the entry path.

2. **Suggestion** (`pome-suggest-tasks`)
   - Input: `pome.json` + the agent's prompt/code; empty `tasks/` and empty
     `list_tasks`.
   - Coach: read the agent, propose 2–3 grounded candidates.
   - Artifact: 2–3 one-line candidates — each fear · twin · bad/good end-state.

3. ⚑ **Pick** (checkpoint 1 — still `pome-suggest-tasks`)
   - Input: the candidate list.
   - Coach: short interview — the builder picks or refines one.
   - Artifact: one chosen candidate (prompt + fear + twin + bad/good end-state).

4. **Authoring** (`pome-author-task`)
   - Input: the chosen candidate.
   - Coach: draft the task markdown, `validate_task`, dry-run `verify_seed`,
     `evaluate_criteria`, then `save_task`.
   - Artifact: a saved task (`task_id`) in the team catalog.
   - Stops if: `validate_task` errors or a `code` criterion is `unmatched` → fix
     with the builder, never save blind.

5. **Verified seed** (`pome-verify-seed`)
   - Input: the saved task.
   - Coach: judge the seed a fair exam — it boots, matches the prompt, and a
     positive discriminator carries the signal.
   - Artifact: verdict **HEALTHY seed**.
   - Stops if: BROKEN / unfair → fix the seed or restate criteria, then
     re-verify (never weaken the exam to pass it).

6. **Run** (`pome-run-task`)
   - Input: the verified task + `agent_id`.
   - Coach: `run_task` mints the session, launch the examinee via the REST
     launcher (preflighted), `finalize_run` the instant it idles.
   - Artifact: a finalized `run_id` with a score, graded off the live twin tape.
   - Stops if: the run comes back red → hand the fix prompt to the builder, who
     edits the **examinee's** prompt (never the task), then re-run only what
     failed.

7. ⚑ **Report** (checkpoint 2 — still `pome-run-task`)
   - Input: `run_id`.
   - Coach: `get_report`, narrate the Score /100 + criteria + dashboard link.
   - Artifact: the **first own-agent finalized report** (Done-when #2).

**Pass criterion for the whole walk (Done-when #3):** a builder starts at a fresh
registered repo and reaches step 7 in one session, the coach stopping only at the
two ⚑ checkpoints and any genuine failure above — no founder help.
