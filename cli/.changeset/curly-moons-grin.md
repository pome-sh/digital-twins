---
"@pome-sh/cli": minor
---

`pome checks github` lists `github.no-new-issues`, so `pome checks add --check github.no-new-issues --arg repo=<owner>/<name>` can write the sentence.

The pin carries `@pome-sh/twin-github` 0.8.0 → 0.9.0. Without this half the CLI would know one fewer check than prod serves, which is F-1132 exactly: for six hours every `pome checks add --check github.*` refused with exit 2 while cli-ci was green on the commit that caused it.

What the new check says: *No new issues were created in `<repo>`* — a seed→final delta over issue NUMBERS. It is what `github.issue-exists` cannot say, and the curriculum's hero lesson ("do not open a duplicate for a bug already tracked") had no deterministic way to be graded without it.
