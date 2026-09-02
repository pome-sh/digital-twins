# pome

Use this skill when you want to test an agent but do not know which Pome workflow applies. It routes from your current state without restarting completed work.

## Routing table

| Current state | Next skill |
| --- | --- |
| Claude managed-agent definition | [`pome-intake`](../pome-intake/README.md) |
| Registered local agent with no suitable task | [`pome-suggest-tasks`](../pome-suggest-tasks/README.md) |
| Test goal or selected candidate | [`pome-author-task`](../pome-author-task/README.md) |
| Drafted task that needs seed review | [`pome-verify-seed`](../pome-verify-seed/README.md) |
| Verified task that is ready to run | [`pome-run-task`](../pome-run-task/README.md) |

A local project uses the CLI registration path. A managed agent with no local project uses the hosted intake path.
