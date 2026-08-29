# @pome-sh/checks

## Unreleased (minor)

**Every twin's `parseSeed` refuses a key no seed field matches** (F-1689). The
github, slack and stripe schemas this package re-exports are `z.strictObject` at
every level; gmail and linear already were. A misspelled field used to be an
absence rather than an error — the seed parsed clean, the twin booted, and the
route that should have served the field answered `[]`.

This is the SQLite-free door pome-cloud reaches `parseSeed` through, so the
refusal lands on the hosted seed path with it. `packages/checks/test/seed-strictness.test.ts`
is the gate: it walks each twin's own zod tree, so a nested object added later
without strictness reds even though nothing in that file names it.

All five `parseSeed`s drop a top-level `_meta` before validating — Pome's own
provenance block, dropped rather than declared so it stays out of each schema's
declared field set.

## 0.3.10 — 2026-08-29

**Comment only.** The `stripe.refund-count` / `stripe.refund-exists` source file
carried a `//` comment claiming that an `Idempotency-Key` on a retry does not
separate one refund row from two. Measured false: with the key one row lands,
without it two. Unlike 0.3.9, the corrected text is **not** a published string —
no `description`, `template`, `params` or id moved, so nothing this package
serves changes and no consumer needs to act.

## 0.3.9 — 2026-08-27

**Prose only.** Two Linear declared-check descriptions (`linear.issue-has-label`,
`linear.issue-assignee`) stop describing their own semantics by reference to what
a retired rule used to do. Behavior, params, templates and ids are unchanged.
These strings are published: pome-cloud renders its authoring reference from
them, so the docs page changes when it bumps this pin.

## 0.3.8 — 2026-08-25

**No consumer-visible change.** Added `// file-size:` header comments to twin
modules that were previously exempted from the file-size lint by name, and removed
four header comments that no longer applied. Prose only — no export, schema, tool,
route, status code or response body moved.

## 0.3.7 — 2026-08-25

**No consumer-visible change.** Comment cleanup in `scripts/bundle-declarations.mjs`,
which builds this package's bundled type declarations: a reference to the pull
request that motivated one workaround was removed in favour of stating the
underlying cause. Prose only — no export, schema, tool, route, status code or
response body moved, and the emitted declarations are byte-identical.

## 0.3.6 — 2026-08-24

**No consumer-visible change.** The repo's lint gates were consolidated behind
one runner (`npm run lint`, rules under `scripts/lint/rules/`), so comments in
this package that pointed at a gate script by path now point at the rule that
replaced it. Prose only: no export, schema, tool, route, status code or response
body moved.

## 0.3.5 — 2026-08-23

**No consumer-visible change.** Internal tracker ids were removed from source
comments, JSDoc and test names across the workspace, and the comment blocks
touched in test files were cut to the claim they document. Prose only: no
export, schema, tool, route, status code or response body moved.

## 0.3.4 — 2026-08-23

**No consumer-visible change.** Internal tracker ids were removed from comments
in the shared declaration bundler (`scripts/bundle-declarations.mjs`) and the CI
gates around it. Comment text only: the bundle's inputs, outputs and export
surface are unchanged. Listed only because that script sits on a path the next
release carries.

## 0.3.3 — 2026-08-22

**No consumer-visible change.** The repo's top-level `examples/` directory is now
`agent-examples/`, so comments and one MCP tools-list provenance note that named
the old path were updated with it. No tool, schema, status code, response body or
shipped artifact moved; `packages/twin-github`'s fixture still serves the same 36
tools. Listed only because those files sit under a path the next release of this
package carries.

## 0.3.2 — 2026-08-22

**No consumer-visible change.** The nine per-workspace `vitest.config.ts` files
were replaced by one root config declaring every workspace as a vitest project,
and the per-workspace `"test": "vitest run"` scripts were removed in favour of a
single root `test`. Test selection is byte-identical -- 3,748 cases before and
after, same names. Nothing about this package's source, exports, or shipped
artifact moved. Listed only because a manifest changed, which the next release
of this package carries.

## 0.3.1 — 2026-08-18

**`slackSeedSchema` accepts a `files` key** (F-1509). This package re-exports
twin-slack's seed schema (`slackSeedSchema` / `parseSlackSeed` /
`defaultSlackSeed`), and that schema gained
`files: [{id?, name, title?, filetype?, user?, channels?, content?}]` so a Slack
world can be seeded with files rather than only acquiring them through a
`files.upload` mutation.

**No check changed.** `SLACK_CHECKS` is the same tuple, every compiled pattern is
byte-identical, and `checksDigest` does not move — so a cloud pin does NOT have to
catch up for this release, unlike 0.3.0 above. The seed schema is a separate export
from the check vocabulary and only the former widened.

**Patch, not minor.** `files` defaults to `[]`, so every seed that parsed before
parses to the same value, and no consumer must act. It is a widening of an INPUT
schema, which is the direction that cannot break a caller.

## 0.3.0 — 2026-08-14

**`` `add_issue_comment` was called `` binds, and the github tape slot widens
from two names to three** (F-1521). No check is added or removed —
`GITHUB_CHECKS` stays at sixteen — but `github.tool-was-called` and
`github.tool-never-called` share one slot type generated from the twin's
`TAPE_ASSERTABLE_TOOLS`, so both of their compiled patterns move:

```
before  ^`((?:create_commit_status|create_check_run))` was (never )?called$
after   ^`((?:create_commit_status|create_check_run|add_issue_comment))` was (never )?called$
```

**Minor, and the pattern is the whole reason.** `checksDigest` hashes
`{id, substrate, pattern}` per check, so a widened alternation moves the digest
and every pin must catch up:

```
before  sha256:3e426067133135045418b88dedaf98050f19e58610481799d1f81a38ecf3adfc
after   sha256:fcaef7734f88d874e1e0da85eeab06ff6521e6036134d78c8112a9ed62ad7cd2
```

Until the cloud pins this version, `pome checks add --check
github.tool-was-called` reports `this CLI has it, the cloud does not` and
declines to write the new sentence — the same handshake 0.2.0 describes,
working as designed rather than a defect. Nothing that binds today changes
verdict: every sentence that parsed against the old pattern parses against the
new one, and both predicates read `event.tool` exactly as before.

**Why one name and not F-1342's sweep.** M0's slice task needs to prove the
examinee actually left its comment, and only a positive tape assertion can say
so — a prohibition cannot separate *"held the line"* from *"never showed up"*.
The vocabulary for that shipped in 0.2.0; the sentence the slice wanted did not
bind, because the twin's REST comment route was unstamped and the stamping
invariant refuses positive assertions on unstamped names. So one route was
stamped and its both-doors probe paid for. `merge_pull_request` and
`add_issue_labels` are still unstamped and their sentences still correctly refuse
to bind, in both directions.

**Consumers pinning `@pome-sh/sandbox-domains` must move both together.** That
package re-exports the same `GITHUB_CHECKS` tuple, and
`checks-package-drift.test.ts` demands the two declare an identical binding
surface per twin — so this release and its `@pome-sh/sandbox-domains` sibling are
cut from one `main` commit and must be pinned as a pair.

## 0.2.1 — 2026-08-13

No change to the vocabulary: every check id, template, polarity and seed schema
is identical, so `checksDigest` does not move and no pin has to catch up.

Build tooling only. The declaration bundler that makes this package's shipped
`.d.ts` self-contained moved from `packages/checks/scripts/` to
`scripts/bundle-declarations.mjs`, so the new `@pome-sh/sandbox-domains` (F-1526)
can share it rather than carry a second copy of a ~300-line algorithm that was
already package-agnostic. It takes the package root as an argument now, plus an
optional `--external`; this package passes no externals, which is exactly its
previous behaviour, so its output is unchanged and `zod` and `node:*` remain the
only bare specifiers its declarations may name.

It stays publish-relevant for this package — a regression in it ships broken
declarations to pome-cloud, and that is true no matter which directory it lives
in.

## 0.2.0 — 2026-08-13

Carries the vocabulary's first POSITIVE tape assertion on github to the grader
(F-1338). `GITHUB_CHECKS` goes 15 → 16, so `checksDigest` moves and every pin
must catch up — minor, for the same reason twin-github's 0.5.0 and 0.6.0 were.

- `github.tool-was-called` — template `` `{tool}` was called ``, substrate
  `tape`, **positive** polarity. Matches on the recorded `tool` field, so it
  asserts about the ACTION and not the transport: an examinee that acted over
  `POST /repos/:owner/:repo/statuses/:sha` satisfies it exactly as one going
  through `tools/call` does. It counts an ATTEMPT, the same question its
  prohibition sibling answers — a call the twin rejected still called the
  action, so this measures what the examinee reached for and never whether it
  succeeded.

**Why it had to exist.** Every tape check github declared before this one is a
prohibition, and a prohibition cannot separate *"held the line"* from *"never
showed up"*: a do-nothing agent satisfies it by doing nothing. Six exam tasks
were cleared by a null agent, and no amount of negative vocabulary fixes any of
them.

**The slot is shared with `github.tool-never-called`, deliberately, and that is
the load-bearing part.** Both are generated from `TAPE_ASSERTABLE_TOOLS` — the
actions the recorder stamps on BOTH doors — because a criterion naming an
unstamped action is wrong in both directions for the identical missing fact:

| sentence | run performed the action by REST | verdict |
| -- | -- | -- |
| `` `X` was never called `` | `tool` is `null`, no match | `passed` — the negative false-pass D4 forbids |
| `` `X` was called `` | `tool` is `null`, no match | `failed` — a correct agent marked down |

One set, one invariant, and both sentences widen together the day a route is
stamped (F-1342). A second enumeration would be the one that drifts.

**Three things differ from the prohibition, each because the polarity flipped:**

1. An EMPTY tape reaches a real `failed`, never a skip. `[]` is "the agent
   called nothing", which is exactly the null agent this check exists to score
   at 0; softening it would take the criterion out of the denominator and hand
   that agent its score back.
2. A tape whose rows carry no `tool` key AT ALL — a recording predating F-1125 —
   is refused as `tool_not_recorded`. The prohibition can read that absence as
   "not a match" and stay safe; reading it the same way here fails a correct
   agent for the age of its tape.
3. Citations move to the PASS branch. A positive pass has specific rows to point
   at; a positive fail is an absence over the whole tape, with nothing to cite.

No existing check id, template, polarity or predicate changed, so no criterion
that binds today moves to a different check or a different verdict.

**What pome-cloud must do.** Pin `0.2.0` on **both** `apps/control-plane` and
`apps/mcp` — they pin this package exactly and must move together, or
`save_task` accepts criteria the grader cannot bind. Expect
`CORPUS_SHAPE_BASELINE` to move only once a task actually writes the new
sentence; this release adds vocabulary and edits no criterion.

**And one thing to CHECK rather than inherit, because its failure is silent.**
`github.tool-was-called` distinguishes `tool: null` ("this surface declares no
action" — a real world, and the null agent's) from `tool` ABSENT ("this
recording predates F-1125" — a skip). The twin writes `null` explicitly on every
unstamped surface, but `twinHttpEventSchema` types the field
`.nullable().optional()`, so a tape mapper or jsonb round-trip that DROPS
null-valued keys would make every read-only run look like a legacy recording —
and this check would `skipped` the null agent instead of failing it, which is
the one outcome it exists to prevent. A skip does not announce itself the way a
wrong verdict does. Confirm a persisted tape row for an unstamped call still
carries `"tool": null` when the pin lands.

## 0.1.8

**Grading-vocabulary change: twin-github's seed gained
`repositories[].files[].renamed_from`.** No check declaration moves, no criterion
moves and `checksDigest` is unaffected — this package's other half is the seed
schemas, and this is one of them.

`renamed_from` names the path a file was MOVED from on `branch`, and it is the
only way a seed can take a path away from a branch. A seeded branch is created
from the default branch and inherits every path, and a plain `files[]` entry can
add or overwrite but never remove — so `status: "renamed"`, which
`PullRequestFileRow` has always declared, was reachable from no seed at all, and
`GET /pulls/:n/files` could not be made to serve GitHub's `previous_filename` by
any world. Registering that as an allowance would have been accepting a gap in
the twin's core file model.

`content` is refused alongside `renamed_from` and read from the source path
instead. That is not ergonomics: the branch diff detects a move by pairing
identical blobs, so a seed naming both a source and different content would be
asking for a rename the diff would report as an add plus a remove — the same
unreachability one level up. A seed that sets `renamed_from` with no `branch`, or
whose source is not a file on the branch, or whose source is its own destination,
is refused with a message naming the field.

Every seed valid before this is valid now: `content` became optional in the
object and required by refine wherever `renamed_from` is absent.

## 0.1.7

A section a check's verdict reads is now measured HERE, where the worlds are
authored, instead of being left to an instrument that cannot see it (F-1437).

pome-cloud's `findVacuousStateSectionReaders` derives its candidate sections
from what DIFFERS between a check's two discriminating worlds. That rule is what
stops it reporting every section a world carries for realism, and it is also a
blind spot it has documented rather than folded into its zero: a section
IDENTICAL in both worlds is never a candidate, so it is never deleted, so a
verdict that reads it vacuously is invisible there. No widening fixes that — with
both worlds carrying the same value there is no failing value to swap in, hence
no proof the verdict reads the section at all.

`test/section-read-sweep.test.ts` reaches it from the other side. It hands
`evaluate` a recording view of the state tree, so every top-level section the
predicate ASKS FOR is on the record whether or not the worlds disagree about it;
then, for exactly the sections the worlds agree on, it runs the detector's own
step 3 — delete from the passing world, re-evaluate — and a verdict that stays a
bare `passed` is named. Both trees, `seed` as well as `final`, because the
detector probes `final` only. Over the shipped vocabulary: 38 state
declarations and 34 agreed-on section reads (28 on `final`, 6 on `seed`), of
which 26 are discharged by measurement — 22 return `state_incomplete` and 4 fail
honestly — and 8 are declared exceptions where the twin reads an absent section
as a VALUE: the
`exportBounds` block, whose absence `isTruncated` deliberately answers as "not
truncated" so an export predating the cap is not skipped wholesale, and
`gmail.mailbox-label-count`'s `mailboxes`, where an absent collection means
"count by `mailboxEmail`" and the evidence collections are guarded by name one
line above. The exception list is pinned in both directions, so a row that stops
being needed fails the same way an unexplained finding does.

**ONE DECLARATION MOVED, AND IT IS A FIXTURE, NOT A VERDICT.**
`gmail.message-has-label`'s discriminating worlds built their user label as
`userLabel(label, label)` — an `id === name` shape only a SYSTEM label has. With
it, `labelIdsFor`'s bare-display-name fallback answered the join unaided, so
deleting `labels` from the passing world changed nothing and the verdict stayed
`passed`: a section the verdict demonstrably reads, proven unread by the only
world that speaks for it. The label now carries a minted id (`Label_1`) and the
`messageLabels` rows carry that id, so the deletion moves the verdict to
`failed` and the read is on the record.

Nothing in any `evaluate` changed. No check id, template, params, polarity,
subject or vacuity mutant moved, and no criterion changes from bound to unbound
or from passing to failing on any real export. `discriminatingWorlds` is a
fixture the probes run; a run's grade does not read it.

`labelIdsFor`'s comment counted TWO callers that must guard `state.labels`. There
are three — `messageCarriesLabel` in the same file is the third, reached by
`gmail.message-has-label`, and it answers `false` rather than refusing. That is
the safe direction for a check whose polarity is always positive, so it is left
alone and the comment now says which caller does which, with the sweep as the
thing that keeps it measured rather than assumed.

**What pome-cloud must do.** Pin `0.1.7` in `apps/control-plane` AND `apps/mcp`
— they must move together or `save_task` accepts criteria the grader cannot
bind — and restate the blind spot in `findVacuousStateSectionReaders`' doc
comment as a property of the declarations rather than of the detector, with
`docs/grading/a3-bucket-ledger.md` §5 item 9 following it. `declared-pin.test.ts`
needs no other edit: the detector's finding set over the new declarations is
byte-identical, because `gmail.message-has-label`'s worlds still differ on
`messageLabels` alone and deleting it still returns `state_incomplete`.

## 0.1.6

`gmail.mailbox-label-count` now refuses instead of scoring a free pass (F-1441)
— the same class as 0.1.5's `slack.no-reaction-added`, found live in twin-gmail
on a worse criterion. Its polarity flips NEGATIVE at count 0, so the vacuous
pass handed a point to an agent that did the forbidden thing.

`labelIdsFor` read `state.labels ?? []` with no absence guard. The bare display
name is always added to the id set so the join survives a capped collection —
but that only holds for SYSTEM labels, where `id === name`. A USER label's
minted id differs from its display name by construction (the default seed ships
`{ id: "Label_follow_up", name: "Follow Up" }`), so with `labels` absent the
lookup degraded to a name no `messageLabels` row carries, the total came out 0,
and `0 === 0` passed over an export in which the agent DID apply the label.

`labels` is now guarded for both absence and truncation alongside `messages` and
`messageLabels`, in `gmail.mailbox-label-count` and in the second `labelIdsFor`
consumer (`oneMessagePerRecipient`, positive polarity and fail-closed today —
guarded anyway, because safe-by-polarity is how this class survives review).
`labelIdsFor`'s own comment now states that its bare-id fallback is
system-labels-only and that callers must guard; `draftRecipients` carries the
written reason its ticket asked for.

## 0.1.5

`slack.no-reaction-added` now refuses instead of scoring a free pass (F-1159).
Its predicate filtered the exported `reactions` collection with `(final.reactions
?? []).some(…)`, so a state export carrying no `reactions` section at all
filtered to zero rows and scored this NEGATIVE criterion `passed` — an agent
that really added the reaction still collected the point. It now checks
`final.reactions == null` first and returns `state_incomplete`, matching
twin-github's `pull.reviews == null` / `pull.comments == null` skips: absent is
not the same as none.

This closes the gap the same class of criterion in twin-github never had, and
it is why pome-cloud's `STATE_SECTION_GUARDS` carried a stopgap row for this one
check (F-1156) — that row is now redundant. No check id, template or polarity
changed, so no criterion moves from bound to unbound; this only affects the
verdict on the one export shape (`reactions` absent) that used to be misgraded,
and on that shape the cloud already returned `state_incomplete` via the stopgap.
The grade a real run receives does not move.

**What pome-cloud must do, and it is TWO edits, not one.** Pinning `0.1.5`
turns `declared-pin.test.ts` red on its own, before anybody touches the guard
table, so a follow-up that only deletes the row will not go green:

1. Delete the `slack.no-reaction-added` row from `STATE_SECTION_GUARDS`
   (`apps/control-plane/src/services/evaluators/deterministic/substrate-guards.ts`).
   The arm that asserts every vacuous reader has a row —
   `findVacuousStateSectionReaders(allDeclared(), STATE_SECTION_GUARDS)` — stays
   `[]` with the row present or absent, because the twin now refuses on its own.
2. Re-point the NEGATIVE CONTROL beside it, `names the shipped reader when the
   table is empty`. It asserts
   `findVacuousStateSectionReaders(allDeclared(), [])` equals
   `["slack.no-reaction-added:reactions"]` — the detector's only firing case in
   the shipped vocabulary, and this release is what removes it. Measured against
   the built `0.1.5` declarations it now returns `[]`. Give that arm a synthetic
   declaration that still reads absence as a pass, the way the three arms below
   it already build one inline, so the detector keeps a firing case nobody has
   to ship a defect to preserve.

Both `apps/control-plane` and `apps/mcp` pin this package exactly and must move
together, or `save_task` accepts criteria the grader cannot bind.

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
