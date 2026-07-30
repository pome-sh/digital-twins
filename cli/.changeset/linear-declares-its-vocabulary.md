---
"@pome-sh/cli": minor
---

`pome checks linear` answers with a vocabulary instead of "not migrated yet" —
eight declared checks covering issue state, labels, estimate, assignee,
comments, threaded replies, existence, and unsupported endpoint calls.

Tasks 24, 25 and 26 are rewritten so every criterion names its own subject. A
rendered sentence cannot say "that issue": under a picked check the author fills
parameters, and a check only ever sees its own arguments. Each Linear check now
names both the issue title and its team, because Linear validates title
uniqueness per team rather than per workspace.

Task 26 loses one criterion rather than gaining a subject: `linear.issue-state`
fails when the issue is absent, so it already subsumes `An issue titled "..."
exists`.
