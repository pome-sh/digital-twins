---
"@pome-sh/cli": minor
---

`pome session stop` learns to recognize a refusal to destroy a session whose run has not been graded, ahead of the control plane sending one. Pome creates the run row at finalize, so an open session holds an ungraded run; once the control plane starts refusing to delete one, this CLI reads what would be lost and, on a human-typed `pome session stop`, requires `--discard` to confirm. Automated teardown paths (a finished or crashed `pome run`, and the rollback of a half-provisioned trial group) already confirm the discard themselves, so they see no behavior change either before or after that control-plane change ships. Nothing here changes how `pome session stop` behaves against today's control plane, which does not yet refuse.
