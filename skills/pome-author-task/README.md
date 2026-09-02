# pome-author-task

## Purpose

This skill writes a graded Pome task and validates its criteria and seed.

## When to use

Use this skill when you have a test goal or a selected candidate task.

## Inputs

- The agent behavior to test.
- One or more supported twins.
- The required initial state.
- The expected final state or recorded behavior.
- Existing tasks that can provide a useful structure.

## Outputs

- A task Markdown file in the project's configured task directory.
- `[code]` criteria that use declared twin checks.
- `[model]` criteria that test required reasoning or intent.
- Validation and seed-review results.
- A team-catalog entry for hosted runs.

## Basic use path

1. Select an existing task to adapt, or define one test goal.
2. Write the task in the project task directory.
3. Run `pome checks <twin>` to inspect declared checks.
4. Add deterministic criteria with `pome checks add`.
5. Add `[model]` criteria for required reasoning or intent.
6. Run `pome checks lint <task-file>`.
7. Validate the task and review its seed.
8. Save the validated task to the team catalog for hosted runs.

See [`references/task-format.md`](./references/task-format.md) for the task grammar and current seed shapes.
