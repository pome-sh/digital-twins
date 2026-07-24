---
"@pome-sh/cli": minor
---

Complete the `scenario` → `task` rename in the shipped CLI (F-892). `pome
scenarios` is now `pome tasks`; the old name survives as a hidden deprecated
alias that still works and prints a one-line pointer. The scaffold directory
and bare-`pome run` demo drop moved from `scenarios/` to `tasks/` (`pome init`,
`pome tasks --copy`, and the "run yours" default all use `tasks/` now), and the
bundled library ships under `tasks/`. Command-adjacent internals were renamed
too (`tasks-catalog.ts`, `TASK_TWINS`, `runnableTasks`, …); the internal
runner/schema symbols (`runScenario*`, `parseScenario`, `Scenario`) are
unchanged and follow in a later mechanical pass.
