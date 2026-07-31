---
"@pome-sh/cli": minor
---

`pome checks github` gains a fourteenth check, and the GitHub twin can finally
record the thing it grades. `github.pr-comment-exists` binds
`` Pull request #N in `<repo>` has at least one comment ``, the sentence six
bundled `pr-summary-*` criteria have carried unbound since the vocabulary was
declared.

The sentence was unbound because "comment" has three readings on a pull request —
a conversation comment, a review's body, or an inline review comment — and
guessing between them ships a check that lies. This one grades the CONVERSATION
timeline, its `description` says so, and says the other two are not it: assert a
review with `github.pr-review-exists`, and an inline comment has no declaration
yet.

Underneath, `add_issue_comment` and `list_issue_comments` now accept a PULL
REQUEST number, which is how real GitHub documents commenting on a PR. They used
to answer `404 Issue not found` for every PR, so an agent whose job is to leave a
summary had no working way to leave one.

Bundled twin pins: `@pome-sh/twin-github` 0.7.0 → 0.8.0. github's checks digest
moves with the new declaration, so `pome checks add --twin github` requires a
control plane on the matching pin.
