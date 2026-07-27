---
"@pome-sh/cli": minor
---

`pome session stop` no longer silently destroys a session whose run has not been graded. Pome creates the run row at finalize, so an open session holds an ungraded run; the control plane now refuses to delete one and names what would be lost. Pass `--discard` to confirm. Automated teardown paths (a finished or crashed `pome run`, and the rollback of a half-provisioned trial group) confirm the discard themselves and are unchanged for users.
