---
"@pome-sh/cli": minor
---

`pome checks github` now lists **eleven** declared checks, not one.

The whole GitHub vocabulary is declared in `@pome-sh/twin-github@0.4.0` — the
ten predicates that used to live as regexes in the cloud are now checks you can
pick, each with its typed parameters, a description of what the predicate
actually compares, and a copy-pasteable `pome checks add` line.

This bump is not optional once the cloud ships the same vocabulary. `pome checks
add` compares its vocabulary digest with the cloud's before writing, so a CLI
still bundling `twin-github@0.3.0` would refuse every write with a digest
mismatch. That refusal is the designed safe behaviour, not a bug — but the fix
is this pin.

Three sentence forms stop binding, and re-rendering them is the repair:

- an issue/PR check must now name its repository — the old patterns took
  ``in `owner/repo` `` as optional and scanned repos first-match-wins without it
- `Issue #N has label X` is gone; there is one check, `github.issue-has-label`
- `A REQUEST_CHANGES review exists …` is gone; the API state is
  `CHANGES_REQUESTED`, and under a picked check there is nothing to fold

Also bundles `@pome-sh/sdk@0.7.0`, whose `defineCheck` now rejects a param
pattern that opens its own capture group — a declaration bug that would
otherwise hand every later slot its neighbour's argument.
