# @pome-sh/checks

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
