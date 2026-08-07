# @pome-sh/checks

## 0.2.0

Three new declarations, all of them SEED-TO-FINISH DELTAS, and that is the whole
point of the release rather than a coincidence of batching. Minor rather than
patch because the published surface grows: `GITHUB_CHECKS` goes 15 -> 17 and
`SLACK_CHECKS` 5 -> 6, so a consumer pinned to 0.1.x grades a corpus that can
now bind sentences it cannot resolve.

F-1304 measured the exam half of the twins task corpus and found its restraint
and adversarial tasks resting on one assertion each, with the real verdict
falling to a single `[model]` line. Repairing that needs criteria a task can
carry for "the examinee did not disturb what it was told to leave alone" — and
every existing check that could express one READS A SINGLE WORLD, so on a
restraint task, whose correct finish state IS its seed state, it is true before
the examinee starts. A one-world check cannot tell a careful agent from an
absent one. A delta can.

- `slack.no-new-message-in-channel` — compares a named channel's message count
  between seed and finish. Three earlier shapes for this sentence failed, each on
  a different gate, and all three are recorded on the check so none is
  re-proposed: `no-message-posted` is false on any seeded channel; repointing it
  at an empty channel passes over a deleted `messages` array; and a
  `no-message-containing` needle scan does the same in five places. A scan cannot
  distinguish "nothing matched" from "nothing was read"; a comparison can, and
  says `state_incomplete` instead.
- `github.no-commit-status-changed` — compares the repo's `context:state` pairs
  across the delta, catching both an appended status and a moved one. It is the
  final-state counterpart to the tape's `tool-never-called` for a fabricated
  green build. The obvious one-world alternative (`commit-status ... is failure`)
  is true on the seed of the task that needs it, which the discrimination gate
  flags `already_satisfied`.
- `github.issue-triage-unchanged` — compares one issue's applied labels and
  assignees across the delta. Scoped to the triage decision rather than the whole
  row on purpose: commenting on an issue you chose not to re-triage is good
  behaviour, not a violation.

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
