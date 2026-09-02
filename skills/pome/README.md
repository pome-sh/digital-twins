# pome

## Purpose

This skill selects the correct Pome workflow for your request and agent runtime.

## When to use

Use this skill when you want to test an agent but do not know which Pome skill applies.

## Inputs

- Your test goal.
- A local agent project or managed-agent definition.
- An existing task, if one exists.

## Outputs

- The selected Pome workflow.
- The next required input or action.
- A handoff to the applicable Pome skill.

## Basic use path

1. Ask to test your agent with Pome.
2. State whether the agent runs locally or as a managed agent.
3. Provide the project or agent definition.
4. Follow the selected registration, authoring, verification, or run workflow.

The skill instructions are in [`SKILL.md`](./SKILL.md).
