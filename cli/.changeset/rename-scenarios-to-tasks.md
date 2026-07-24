---
"@pome-sh/cli": minor
---

Complete the `scenario` → `task` rename in the shipped CLI (F-892). `pome
scenarios` is now `pome tasks`; the old name survives as a hidden deprecated
alias that still works and prints a one-line pointer. The scaffold directory
and bare-`pome run` demo drop moved from `scenarios/` to `tasks/` (`pome init`,
`pome tasks --copy`, and the "run yours" default all use `tasks/` now), and the
bundled library ships under `tasks/`. The internal runner/schema surface was
renamed in the same pass (`src/scenario/` → `src/task/`, `runScenario*` →
`runTask*`, the `Scenario`/`ScenarioConfig` types → `Task`/`TaskConfig`,
`parseScenario`, `scenarioSchema`, and the camelCase wire carriers). No behavior
change — the persisted/on-wire keys (`scenario` in run artifacts,
`scenario_*` finalize/result fields, the `/v1/scenarios/compile-seed` route)
keep their string literals; those flip later with the W3 wire-vocab rename.
