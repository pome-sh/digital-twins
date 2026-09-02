# pome-suggest-tasks

## Purpose

This skill proposes test tasks from a local agent's tools, prompt, source code, and configured twins.

## When to use

Use this skill after registration when the project has no suitable task.

## Inputs

- A valid `pome.json` manifest.
- The agent command, prompt, tools, and relevant source code.
- The twins that the task can use.
- Existing local or team tasks, when available.

If the manifest has no `twins` field, specify the twins before task selection.

## Outputs

- Two or three task candidates.
- The risk, target twin, and expected end state for each candidate.
- One selected candidate for `pome-author-task`.

## Basic use path

1. Register the local project with `pome register agent <name>`.
2. Ask for task suggestions.
3. Let the skill inspect the manifest and agent source.
4. Select or revise one candidate.
5. Continue with `pome-author-task`.

See [`references/cold-walk.md`](./references/cold-walk.md) for the full path.
