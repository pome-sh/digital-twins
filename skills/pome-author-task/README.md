# pome-author-task

Use this skill when you have one test goal or a selected candidate. It writes the task in the configured task directory and prepares it for hosted runs.

## Authoring rules

Adapt a relevant task when one exists. Use `pome checks <twin>` to inspect declared checks, and use `pome checks add` for `[code]` criteria. Add a `[model]` criterion only when the task requires observable reasoning or intent.

Run `pome checks lint <task-file>`. Validate the complete task and verify its seed before you save it to the team catalog.

See [`task-format.md`](./references/task-format.md) for the grammar, hosted and local differences, and seed schemas.
