---
"pome-sh": minor
---

`pome install` — agent-driven wiring with the diff gate in your coding agent's own edit-approval UI. Checks auth (routes through `pome login` when needed), detects your coding agent, ensures the evolved `pome-setup` skill, hands off to an interactive session, then verifies the wiring with `pome doctor` to green. No coding agent on PATH → prints manual wiring steps plus a paste-into-any-agent prompt. The `pome-setup` skill is rewritten adapter-first (`withPome()` + env-injected base URLs) with hard rules: no secrets in source, read-before-write, minimal targeted edits, diff approval before applying, and doctor-green as the only done.
