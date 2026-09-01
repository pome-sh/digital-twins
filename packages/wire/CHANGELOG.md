<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/wire — CHANGELOG

## Unreleased (patch)

Doc-only: source comments and the README no longer reference the removed
`@pome-sh/adapter-claude-sdk` package. No API or behaviour change.

## 0.4.0 — 2026-08-26

**`@pome-sh/wire/run-completeness` learns the narrator's two states.** A run
whose every `[code]` criterion was scored no longer reads `incomplete` because
its `[model]` rows carry the narrator's reading instead of a score.

`isIncompleteTally`'s clause 2 was `notEvaluated - preSatisfied > 0`, and the
seed exclusion was the only exemption it knew. An advisory `[model]` row is
`passed: false, skipped: true` with the narrator's prose in `reason`, so it
counted as an abstention — and a run with three scored `[code]` criteria beside
two advisory `[model]` ones was reported as a run the grader never finished, on
every surface that asks this question. Measured, not inferred.

Added:

- `ADVISORY_SCORE_STATE` (`"advisory"`) and `ABSTAINED_SCORE_STATE`
  (`"abstained"`) — the two values a `criteria_results` row carries in
  `score_state` when `skipped` alone is too coarse. Owned here for the reason
  `PRE_SATISFIED_REASON` is: the predicate below reads them, so a drift in
  either string is a silent drift in the predicate. The zod field stays in
  pome-cloud's `@pome-cloud/contract`, which serves it and builds its
  `criterionScoreStateSchema` from these two constants.
- `CriterionResultLike.score_state?: string` — typed `string` rather than a
  union of the two, exactly as `reason` is not a union of the reason codes, so a
  state this version has never heard of is a value nothing recognises rather
  than a parse error. An unrecognised spelling is not exempted from anything.

  The field is `score_state` and **not** `outcome`: the CLI's display model has
  long reserved `outcome` on this same row for a disjoint vocabulary
  (`passed | failed | skipped | errored`), and its `outcomeOf` prefers the wire
  value over the booleans — so a cloud writing `advisory` into that key would
  render an advisory row with the skipped glyph, which is the conflation these
  states exist to remove.

Changed:

- **`CriteriaTallyLike` gains required `advisory: number` and
  `abstained: number`** — the reason this is a minor. They are DISJOINT SUBSETS
  of `notEvaluated`, on the same footing as `preSatisfied`: `evaluated +
  notEvaluated` still equals `total`, and a consumer that ignores all three gets
  the legacy arithmetic rather than a wrong one. Disjointness is load-bearing —
  the predicate subtracts all three, so a reduction counting one row into two of
  them would drive the clause negative and exempt a real gap.
- `isIncompleteTally` clause 2 is now
  `notEvaluated - preSatisfied - advisory - abstained > 0`. **Clause 3
  (`evaluated === 0`) and clause 1 (`total === 0`) are unchanged**: a
  `[model]`-only run genuinely is neither a pass nor a failure, so `incomplete`
  is the right verdict class there and only its wording was ever wrong.
- `tallyCriteriaResults` counts the two new fields off `score_state`, and only
  on a row that is `skipped` — a `score_state` on a scored row is ignored rather
  than subtracted from a bucket it was never in.

For pome-cloud, this is a pin bump with no type edits: `CriteriaTally`
(`services/score-merge.ts`) and `CriteriaCounts` (`dashboard/src/lib/
run-status.ts`) already carry both names, and the interface is structural.
⚠️ One hazard in the same bump — `deriveCriteriaCounts` returns
`{ passed, advisory, abstained, ...tallyCriteriaResults(results) }`, spread
LAST, so wire's counts now silently overwrite the locally-computed ones. They
agree today, which is what makes it invisible. Delete the local counting or move
the spread first.

## 0.3.3 — 2026-08-24

**No consumer-visible change.** The repo's lint gates were consolidated behind
one runner (`npm run lint`, rules under `scripts/lint/rules/`), so comments in
this package that pointed at a gate script by path now point at the rule that
replaced it. Prose only: no export, schema, tool, route, status code or response
body moved.

## 0.3.2 — 2026-08-23

**No consumer-visible change.** Internal tracker ids were removed from source
comments, JSDoc and test names across the workspace, and the comment blocks
touched in test files were cut to the claim they document. Prose only: no
export, schema, tool, route, status code or response body moved.

## 0.3.1 — 2026-08-23

**No consumer-visible change.** Internal tracker ids were removed from this
package's README. Documentation prose only; every export is unchanged.

## 0.3.0 — 2026-08-23

**BREAKING — the legacy event → span shim is removed.** `src/otel/legacy-shim.ts`
translated the three pre-OTel recorder variants (`TwinHttpEvent`, `LlmCallEvent`,
`ToolUseEvent`) into `OtelSpanEvent`s for a transition window that has since
closed. Nothing in this repo called it outside its own test, and no consumer
outside it does either, so the translation was maintained for a caller that never
arrived.

Removed from the root barrel and from `@pome-sh/wire/otel`:

- `shimLegacyEventToSpan`, `shimmableLegacyEventSchema`, `ShimmableLegacyEvent`,
  `LegacyShimOptions`
- `LEGACY_SHIM_SEMCONV_VERSION`, `LEGACY_ATTR_NAMESPACE`, `LEGACY_ID_PREFIX`

Removed from `@pome-sh/wire/otel/fixtures` along with it, because the family
existed only to feed the shim's golden test:

- `getLegacyFixtures`, `getLegacyFixtureByName`, `LEGACY_FIXTURES`
- the `LegacyFixture`, `LegacyEventRecord` and `LegacyFixtureShimOptions` types

Unchanged: `eventSchema`, `recorderEventSchema`, `otelEventSchema`,
`otelSpanEventSchema`, `mapOtelSpanToEvent`, the `semconv` pins, and the emitter /
trace / external-API fixture families. `OtelSpanEvent` still accepts `legacy:<id>`
trace and span ids, so spans the shim already produced remain valid on the wire —
only the code that produced them is gone.

## 0.2.5 — 2026-08-22

**No consumer-visible change.** The nine per-workspace `vitest.config.ts` files
were replaced by one root config declaring every workspace as a vitest project,
and the per-workspace `"test": "vitest run"` scripts were removed in favour of a
single root `test`. Test selection is byte-identical -- 3,748 cases before and
after, same names. Nothing about this package's source, exports, or shipped
artifact moved. Listed only because a manifest changed, which the next release
of this package carries.

## 0.2.4 — 2026-08-21

**The README no longer links a `RELEASING.md` that does not exist.** No code
change; the two-registry publish model it described is unchanged.

## 0.2.3 — 2026-08-13

**New subpath: `@pome-sh/wire/run-completeness`.** Additive — no existing export,
schema, type or behaviour changed, and the root barrel's snapshot is
byte-identical.

Three symbols and two structural interfaces: `isIncompleteTally`,
`tallyCriteriaResults`, `PRE_SATISFIED_REASON`, `CriteriaTallyLike`,
`CriterionResultLike`. Together they answer one question — does this finished
run have a verdict to state, or did its grader fail to produce one? — over the
`skipped` and `reason` fields of a `criteria_results` row.

They moved here from pome-cloud's private `packages/contract` (F-1416). Four
surfaces in two repositories ask that question about the same run: pome-cloud's
dashboard badge and markdown report header, and this repo's CLI terminal verdict
and `verdict.json` `state`. F-1399 had already collapsed the two pome-cloud
copies into one predicate, and they have not drifted since. Across the repo
boundary the defect survived: `cli/test/unit/hosted/cross-surface-agreement.
test.ts` held a hand-written transcription of the predicate so it could assert
the CLI and the dashboard never split on "did this pass", and it went stale the
moment F-1399 changed the original — stale GREEN, passing while asserting
something false about the other repo. Neither repo could fix that alone:
`@pome-cloud/contract` is private and unpublished, `lint-no-cloud-imports.sh`
denies the import by design, and no CI check here could diff a transcription
against a private source. wire is the one package that already crosses this
boundary, so the predicate lives here now and both sides import it.

**Subpath-only, deliberately off the root barrel.** The barrel's F-942 doc says
nothing on it knows about sessions, tasks, runs or the cloud REST surface, and
the five twins / the sdk / the adapter — every root-barrel consumer — have no
run to ask about. `test/export-surface.test.ts` fails if any of these symbols
appears on the barrel. The barrel's doc was narrowed to name this one exception
and why it is not a loosening: the predicate reads two fields of a wire row and
returns a boolean, names no session / task / run id / REST route / column,
imports nothing, and takes structural inputs so no cloud type crosses with it.

`trace-contract.json` gains the `runCompleteness` entry in its `exports` map,
for the same reason `correlation` is in there and `otel/fixtures` is not: it is
a surface a consumer codes against, not a test artifact.

Consumers must move together — pome-cloud's eight `@pome-sh/wire` pins go
`0.2.1 → 0.2.3` in one change, and its dashboard, control plane and markdown
report import from `@pome-sh/wire/run-completeness` instead of from
`@pome-cloud/contract`, whose copy is deleted.

## 0.2.2 — 2026-08-12

No schema, type, export or behaviour change. F-1488 fixed
`scripts/emit-trace-contract.mjs`'s entry guard: it compared
`process.argv[1]` against `import.meta.url` with no `realpathSync` on either
side, so the guard fell false and the script exited 0 having emitted nothing
when reached through a symlinked checkout (a `git worktree`, or macOS's
symlinked `/tmp`). Both sides are realpath'd now, and a guard miss while
invoked as this file throws rather than exits 0.

The script itself is dev tooling that ships in no tarball, but its OUTPUT does:
`trace-contract.json` is in this package's `files` array and embeds the package
version, so the bump changes one byte of the published artifact and
`check:trace-contract` (wired in both ci.yml and release.yml) reds until it is
re-emitted. The bump is therefore self-justifying, not the packaging-only kind
0.2.1 was.

Wire had no changelog before 0.2.1 because it had never been published. Earlier
versions exist only as bytes inlined into `@pome-sh/cli` and
`@pome-sh/adapter-claude-sdk`; their history is in those packages' changelogs.

## 0.2.1 — 2026-08-06

**First published version.** Packaging only — no schema, type, export or
behaviour change from 0.2.0.

`@pome-sh/wire` was `private: true` and reached the outside world only as bytes
tsup inlined into `@pome-sh/cli` and `@pome-sh/adapter-claude-sdk`. It is now
also published as an independently versioned artifact to **GitHub Packages**
(`npm.pkg.github.com`), for consumers in other repositories — today
`pome-sh/pome-cloud`, which speaks the same trace vocabulary and had been
reaching it across a repo boundary through npm-installed internal packages
(F-949).

- `private: true` → `private: false`; added
  `publishConfig.registry: https://npm.pkg.github.com`. It is **not** on npmjs
  and is not an end-user install surface — reading it requires a GitHub token.
- `README.md` added to the `files` field so the published package has a readme.
- `!dist/**/*.map` added to `files`. `tsconfig.json` sets `sourceMap: true` and
  no `src/` ships, so every emitted `.js.map` was a dangling map with no
  `sourcesContent` — 14 of them. `scripts/clean-room-pack-test.mjs` already
  treats a dangling map in a published tarball as a hard failure for the other
  two packages (F-943); wire's tarball now holds to the same rule. Local builds
  keep their maps.
- Published by the new `publish-wire` job in `.github/workflows/release.yml`,
  on the same version-diff-on-push model as the two npm packages but with
  `GITHUB_TOKEN` auth instead of npm OIDC Trusted Publishing.
- `trace-contract.json` moves by exactly one line: it embeds wire's own
  `version`, so `check:trace-contract` fails on any version bump until
  `emit:trace-contract` is re-run. Every future wire release must regenerate it
  in the same commit.

**The bundled path is unchanged.** `cli/` and `packages/adapter-claude-sdk/`
still declare wire as a `devDependency` at `"*"` and tsup's
`noExternal: [/^@pome-sh\//]` still inlines it, so neither published npm
tarball has an `@pome-sh/wire` dependency and no end user ever resolves it from
a registry. Do not turn wire into a runtime dependency of either: GitHub
Packages requires auth to read, so an end user's `npm i` would 401.

Verified from outside the workspace before release: the packed tarball installs
into a bare directory with `zod` as its only peer, all six subpath exports
import, and a consumer typechecks against the shipped declarations under
`NodeNext` without `skipLibCheck`.
