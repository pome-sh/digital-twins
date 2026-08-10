# @pome-sh/checks

## 0.1.4

Carries twin-github's widened seed schema to the grader (F-1421). One thing
moves in `dist/`: `@pome-sh/checks/github`'s re-exported `seedSchema` — and with
it `parseSeed` — now accepts five entity types it used to strip silently.

- `repositories[].milestones[]`, `repositories[].tags[]`,
  `repositories[].releases[]`
- `repositories[].issues[].comments[]` and
  `repositories[].pull_requests[].comments[]`
- `repositories[].pull_requests[].review_comments[]`

Every one is optional with a `[]` default, so a seed that parsed before parses
to the same value now. This is a widening, not a tightening: nothing a consumer
already sends can start failing.

Why it is owed a release rather than left to the twin: this package's job is to
carry the twins' seed schemas to a consumer that has no twin, and a consumer
validating a seed against 0.1.3 would strip exactly the keys twin-github 0.10.2
now honors — reporting a seed as accepted and a world as seeded while five
entities were dropped on the way. The two halves have to move together or the
copy on the grader's side becomes the one that decides what a seed may say.

No check declaration, template, polarity or vacuity sentinel changed, so no
existing criterion's verdict moves.

## 0.1.3

No change to the published surface — `dist/` is byte-identical to 0.1.2, so no
declaration moved and no consumer's verdict changes. The declaration layer has
not been touched since 0.1.2 was cut (`38acaf9`), which is the version-bump
gate doing its job rather than an absence of work.

What this version is for: it is the first release cut by following
[`RELEASING.md`](../../RELEASING.md) end to end since the `packages-v*` batch
flow was replaced by version-diff-on-push, and it exists to prove that runbook
is followable — bump, merge, `release.yml` publishes, pome-cloud pins. The
consumer half is the part that was actually owed: pome-cloud has been pinned at
0.1.1 since before 0.1.2 shipped, so F-1157's redaction-survival vocabulary has
not reached the grader.

Version-only bumps are accepted here rather than carrying an exception list,
per `cli/CHANGELOG.md` 0.21.7.

## 0.1.2

Carries F-1157 to the grader. Three things move in `dist/`:

- `@pome-sh/checks/dsl` gains `probeRedactionSurvival`, `REDACTION_PLACEHOLDER`
  and `isRedacted` — the measurement of what protects a criterion whose
  redaction-destroyed literal is NOT its declared `subject`. `REDACTION_PLACEHOLDER`
  is the check-side half of a cross-repo contract: the token pome-cloud's state
  redactor writes is the token these predicates recognise, and it is declared
  once here rather than spelled twice.
- `@pome-sh/checks/gmail` — `gmail.mailbox-label-count` answers
  `mailbox_redacted ("…")` where the mailbox row survived with its address
  masked, and keeps `mailbox_not_found ("…")` for an export that lists real
  addresses and not this one. Same `skipped` status either way; only the reason
  a report renders changes.
- `@pome-sh/checks/slack` — `slack.no-reaction-added` declares its reaction name
  as its `subject`, so the engine's redaction-survival arm skips such a
  criterion at the door instead of letting a masked `reactions[].name` satisfy
  a negative assertion.

## 0.1.1

No change to the published surface — `dist/` is byte-identical to 0.1.0, so no
declaration moved and no consumer's verdict changes. What moved is the test that
protects that surface, and it moved because the surface acquired a real consumer:
pome-cloud F-1349 pointed all 19 of its grading import sites here, so the
per-twin subpaths are now load-bearing rather than provided-for-later.

- `per-twin subpaths` pins each twin's seed schema by its EXACT name instead of
  asking whether any of three names is present. The old assertion passed as long
  as one of `seedSchema` / `gmailSeedSchema` / `linearSeedSchema` existed on the
  module, so gmail exporting `seedSchema` would have been green here and a
  compile error in the consumer.
- The same arm now pins `defaultSeedState` (github/gmail/linear/slack) and
  `defaultSeed` (stripe), which nothing pinned before. The barrel exports the
  same values under prefixed aliases (`defaultGitHubSeed`, …) and the barrel arm
  covers those, so a subpath dropping or renaming them was invisible.
- Each subpath's default seed is called and round-tripped through that subpath's
  own `parseSeed`, since a factory that is present but broken reads the same as
  one that works.

## 0.1.0

First release. Carries the grading vocabulary of all five digital twins so a
publish + pin bump.

- The five check arrays (`GITHUB_CHECKS`, `SLACK_CHECKS`, `STRIPE_CHECKS`,
  `GMAIL_CHECKS`, `LINEAR_CHECKS`), keyed as `TWIN_CHECKS`.
- Each twin's seed schema, `parseSeed` and default seed, prefixed by twin in the
  barrel and under the twin's own names on the per-twin subpaths.
- The check DSL from `@pome-sh/sdk/checks`, re-exported whole.

`@pome-sh/sdk` and the five `@pome-sh/twin-*` packages stay `private: true`;
their compiled output is inlined here by tsup, so this package declares zero
`@pome-sh/*` runtime dependencies. `zod` is a peer dependency, never bundled, so
a consumer's process holds exactly one zod schema identity.
