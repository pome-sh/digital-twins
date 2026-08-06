# @pome-sh/checks

## 0.1.0

First release. Carries the grading vocabulary of all five digital twins so a
corrected check declaration can reach a cross-repo consumer through a normal
publish + pin bump (F-1308).

- The five check arrays (`GITHUB_CHECKS`, `SLACK_CHECKS`, `STRIPE_CHECKS`,
  `GMAIL_CHECKS`, `LINEAR_CHECKS`), keyed as `TWIN_CHECKS`.
- Each twin's seed schema, `parseSeed` and default seed, prefixed by twin in the
  barrel and under the twin's own names on the per-twin subpaths.
- The check DSL from `@pome-sh/sdk/checks`, re-exported whole.

`@pome-sh/sdk` and the five `@pome-sh/twin-*` packages stay `private: true`;
their compiled output is inlined here by tsup, so this package declares zero
`@pome-sh/*` runtime dependencies. `zod` is a peer dependency, never bundled, so
a consumer's process holds exactly one zod schema identity.
