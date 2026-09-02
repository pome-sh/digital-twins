# First task path

Use this transition map to move a local project to its first graded report. Follow the linked guide for each procedure.

## Transition map

The project must contain exactly one manifest: `pome.json`, `pome.yaml`, or `pome.yml`. If none exists, run `pome init --bare`. If more than one exists, remove the duplicate manifest before you continue.

| Current state | Required transition | Next guide |
| --- | --- | --- |
| One valid manifest, agent not registered | Set the agent command. Set twins if the GitHub default is not correct. Run `pome login` and `pome register agent <name>`. | [`pome-suggest-tasks`](../README.md) |
| Registered agent, no suitable task | Select one risk grounded in the configured agent. | [`pome-suggest-tasks`](../README.md) |
| Candidate selected | Write, validate, and save the task. | [`pome-author-task`](../../pome-author-task/README.md) |
| Task saved | Verify the initial state and criterion intent. | [`pome-verify-seed`](../../pome-verify-seed/README.md) |
| Seed verified | Run the agent and read the hosted report. | [`pome-run-task`](../../pome-run-task/README.md) |
| Valid criterion failed | Correct the agent. Keep the task unchanged. | [`pome-run-task`](../../pome-run-task/README.md) |

Stop at any failed transition. Correct its reported cause before you continue.
