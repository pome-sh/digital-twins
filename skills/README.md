# Pome skills

These skills help you define, verify, run, and review tests for an agent that uses Pome digital twins.

## Install

Install all six skills:

```bash
npx skills add pome-sh/digital-twins --skill '*'
```

Connect the Pome control MCP when you use hosted skills or MCP tools:

```bash
claude mcp add --transport http pome https://mcp.pome.sh/mcp
```

The installation includes each skill's `references/` directory. For CLI-only use, start with `pome init` and `pome docs getting-started`.

## Route requests

| Skill | Use it for |
| --- | --- |
| [`pome`](./pome/README.md) | Select the correct Pome workflow. |
| [`pome-intake`](./pome-intake/README.md) | Register a managed agent and report twin coverage. |
| [`pome-suggest-tasks`](./pome-suggest-tasks/README.md) | Propose test tasks from a registered local agent. |
| [`pome-author-task`](./pome-author-task/README.md) | Write and validate a graded task. |
| [`pome-verify-seed`](./pome-verify-seed/README.md) | Check that a seed creates a valid and useful initial state. |
| [`pome-run-task`](./pome-run-task/README.md) | Run a verified task and report the result. |
