---
"@pome-sh/cli": minor
---

`pome init` now detects an existing project and skips the starter library
(F-904). When the current directory already has a `package.json` (the "bring
your own agent" case), `init` writes only the `pome.json` manifest — no more
dumping the 28-file starter set (the GitHub twin's task+seed pairs into `tasks/`
and the sample agents into `examples/agents/`) into a repo that already has
source. In this bare mode the manifest omits `command` so the user points it at
their own launch command, and if a `tasks/` directory already exists it records
`tasks: "tasks"` so bare `pome run` (F-865) can resolve it. The fresh/empty-dir
starter drop is unchanged, and now also records `tasks: "tasks"`. Two override
flags: `--bare` forces manifest-only anywhere, `--starter` forces the full
library even in an existing project.
