---
"@pome-sh/cli": minor
---

Criterion markers in scenario markdown are now `[code]` / `[model]` (with twin tags `[code:<twin>]` / `[model:<twin>]`). The legacy `[D]` / `[P]` markers are no longer accepted: the parser fails with a migration hint (`[D]→[code]`, `[P]→[model]`) instead of silently skipping the line. Update your scenario files by replacing the markers; criterion semantics are unchanged (`[code]` = deterministic state check, `[model]` = LLM-judged).
