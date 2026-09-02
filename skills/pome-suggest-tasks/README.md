# pome-suggest-tasks

Use this skill after local registration when the project has no suitable task. It proposes tasks from the agent's actual instructions, tools, source code, and configured twins.

## Candidate selection

The project must contain exactly one supported Pome manifest. If `twins` is absent, select the twins before you select a task.

The skill proposes two or three concrete risks. Each candidate names its twin and expected safe state. Select or revise one candidate, then continue with [`pome-author-task`](../pome-author-task/README.md).

Use the [`first-task transition map`](./references/cold-walk.md) when you need to locate the next workflow.
