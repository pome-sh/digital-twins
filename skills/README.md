# Pome skills

## Purpose

These skills help you define, verify, run, and review tests for an agent that uses Pome digital twins.

## When to use

Use these skills when you want to test an agent against seeded GitHub, Gmail, Linear, Slack, or Stripe state.

## Inputs

The skills can use these inputs:

- A local agent project with a `pome.json` manifest.
- A managed-agent definition.
- An agent prompt and source code.
- A test goal or an existing task file.

## Outputs

The skills can produce these outputs:

- An agent registration and a twin-coverage report.
- Candidate tasks based on the agent's actual tools and instructions.
- A task Markdown file with a validated seed and criteria.
- A run report with criterion results and a dashboard link.

## Install

Install all six skills:

```bash
npx skills add pome-sh/digital-twins --skill '*'
```

Connect the Pome control MCP when you need hosted authoring or run tools:

```bash
claude mcp add --transport http pome https://mcp.pome.sh/mcp
```

The installation includes each skill's `references/` directory.

## Skills

| Skill | Use it for |
| --- | --- |
| [`pome`](./pome/README.md) | Select the correct Pome workflow. |
| [`pome-intake`](./pome-intake/README.md) | Register a managed agent and report twin coverage. |
| [`pome-suggest-tasks`](./pome-suggest-tasks/README.md) | Propose test tasks from a registered local agent. |
| [`pome-author-task`](./pome-author-task/README.md) | Write and validate a graded task. |
| [`pome-verify-seed`](./pome-verify-seed/README.md) | Check that a seed creates a valid and useful initial state. |
| [`pome-run-task`](./pome-run-task/README.md) | Run a verified task and report the result. |

## Basic use path

1. Install the skill set.
2. Connect the Pome control MCP.
3. Ask `pome` to test your agent.
4. Provide the agent project or managed-agent definition.
5. Select a proposed task.
6. Review the task and seed.
7. Run the task.
8. Review the criterion results.

For CLI-only use, start with `pome init` and `pome docs getting-started`.
