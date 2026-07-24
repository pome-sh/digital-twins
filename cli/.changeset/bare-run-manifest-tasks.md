---
"@pome-sh/cli": minor
---

Wire the manifest `tasks` key into bare `pome run` (F-865). A migrated project
that declares a task directory (`tasks: "tasks"` in `pome.json`) now has bare
`pome run` run that whole declared set — exactly like `pome run <that-dir>`,
each file at its own `runs`/`-n` — instead of ignoring it and dropping the
`tasks/first-run-demo.md` demo. Un-migrated projects (no manifest, or no
`tasks` key) keep today's "that was ours, run yours" demo default unchanged. A
declared-but-missing directory errors as a usage error (exit 5) rather than
silently falling back to the demo; an empty declared directory prints a
"0 tasks found" note and exits 0.
