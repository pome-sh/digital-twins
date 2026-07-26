---
"@pome-sh/cli": minor
---

Run artifacts now speak "task", not the retired "scenario": `runs/latest.json` records the task slug under `task` (was `scenario`), and each trial's `verdict.json` records `task_path` (was `scenario_path`, next to the already-correct `task_name`). Scripts reading `latest.json` for `run_dir`/`run_id` are unaffected; anything reading the `scenario` key must switch to `task`. `pome fix-prompt` still reads `verdict.json` files written by earlier CLI versions — the old `scenario_path` spelling is accepted on read.
