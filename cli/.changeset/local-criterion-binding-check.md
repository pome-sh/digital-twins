---
"@pome-sh/cli": minor
---

You can now find out locally whether a task's `[code]` criteria will actually be graded.

A `[code]` criterion that binds no declared check is not an error anywhere: the
grader skips it and computes the score over the rest, so the denominator moves
for a reason nobody wrote down. Until now the only things that refused one were
`save_task` and `validate_task` over the hosted MCP — so an author writing tasks
in their own repo, offline or not, had no way to ask the question, and the first
signal was a run whose score had quietly dropped a criterion.

Two changes, both answered from this CLI's own pinned declarations, so they work
with no network:

- **`pome checks add` now audits the whole `## Success Criteria` block**, not just
  the line it appends. Hand-edit a rendered sentence one word off and the next
  append names it. It **warns and still writes** — an unrelated pre-existing line
  is not a reason to refuse an append.
- **`pome checks lint <file...>`** answers the same question about files already on
  disk. Shell globs work (`pome checks lint tasks/*.md`), and it exits 1 when a
  criterion will not be graded, so it drops straight into your own CI.

Both name what is wrong rather than just flagging a line. A sentence that keeps a
check's shape but fills a slot with a value that slot's type rejects is reported
as the corrupted instance it is — naming the check, the slot, and the value —
because that one fails at finalize as `corrupted_check_instance:<id>`, while a
sentence matching nothing is the silent one.

A criterion whose twin has not migrated its vocabulary yet (stripe, slack, gmail,
linear) is reported as **unanswerable**, never as a pass: this CLI holds no
declaration to judge it by, and saying "fine" would be a guess.

Also fixes a cosmetic wart: the first criterion written into an empty
`## Success Criteria` section no longer lands flush against the next heading.
