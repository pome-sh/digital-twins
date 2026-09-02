# pome-run-task

Use this skill after task validation and seed verification succeed. It runs the registered agent and reports the hosted grade.

## Controlled run

1. Call `run_task`, or use `run_trials` for multiple trials.
2. Tell the builder the returned `eval_cost` before you launch the agent.
3. Protect `agent_token` as a credential.
4. Launch from the complete `examinee_launch` data.
5. Call `finalize_run` as soon as the agent becomes idle.
6. Call `get_report` with the returned run identifier.

Use the [managed-agent launcher](./references/launch-managed-agent.md) or the [REST launcher](./references/launch-rest.md), as specified by `examinee_launch.transport`.

Correct the agent, not a valid task, after a failure. A post-fix rerun requires a new `agent_version`, a fresh `group_id`, and the prior `group_id` as `baseline_group_id`.
