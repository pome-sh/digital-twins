# pome-run-task

## Purpose

This skill runs a verified task against an agent and reports the hosted grading result.

## When to use

Use this skill after task validation and seed verification succeed.

Use it again after you change the agent and assign a new agent version.

## Inputs

- A verified `task_id`.
- The registered `agent_id`.
- A declared `agent_version`.
- The agent runtime and launch configuration.
- The task trial count and pass threshold.

## Outputs

- A finalized run identifier.
- A score and per-criterion results.
- The grading provenance and dashboard link.
- A comparison with the baseline after a corrected-agent run.

## Basic use path

1. Confirm that the task seed passed verification.
2. Call `run_task`, or call `run_trials` for multiple trials.
3. Launch the agent from the returned `examinee_launch` data.
4. Protect the returned `agent_token` as a credential.
5. Call `finalize_run` as soon as the agent becomes idle.
6. Call `get_report` with the returned run identifier.
7. Correct the agent, not the task, when the agent fails a valid criterion.

Use the applicable launcher:

- [`references/launch-managed-agent.md`](./references/launch-managed-agent.md)
- [`references/launch-rest.md`](./references/launch-rest.md)
