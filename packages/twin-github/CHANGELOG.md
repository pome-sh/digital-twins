# @pome-sh/twin-github — CHANGELOG

## 0.5.0 — 2026-07-29

`No unsupported endpoint was called` is declared here now (F-1076). It was the
one GitHub predicate F-1075 left behind as a regex in pome-cloud, because
whether a declaration may read the tape was D1's open half and declaring a
substrate nothing supplied would have been a promise with no engine behind it.
Minor for the same reason 0.4.0 was: the exported tuple changes shape.

- **Requires `@pome-sh/sdk` >= 0.8.0.** The declaration reads
  `CheckSubstrate.tape`, which does not exist before it.
- `GITHUB_CHECKS` goes from eleven entries to twelve, adding
  `github.no-unsupported-endpoint` — the first and so far only check declaring
  `substrate: "tape"`. GitHub now has no hand-written predicate left anywhere.
- Why this check cannot read state: an unsupported call leaves no state trace at
  all. The twin answers 501 and mutates nothing, so `state_final.json` is
  byte-identical whether the examinee reached for an unimplemented route or
  never tried. The `fidelity: "unsupported"` stamp on the recorded event is the
  only place the fact survives.
- It does NOT name a repository, and that is deliberate. The repo rule exists to
  stop a check selecting state ambiguously — the legacy patterns scanned
  repositories first-match-wins. This one selects no state, so a `{repo}` it
  never reads would tell a reader the assertion is repo-scoped when it is not.
  The exception is ledgered in `checks-contract.test.ts` as `REPO_FREE_CHECKS`,
  gated so that only a tape-substrate check may sit in it.
- The legacy regex's alternate phrasings are retired rather than ported: the
  optional twin word ("No unsupported GitHub endpoint was called") and the
  plural/`were` variants. Under position 2 an author picks the check rather than
  typing the sentence, and the corpus says the canonical form in all ten places
  it appears.

## 0.4.0 — 2026-07-29

The whole GitHub vocabulary is declared here now (F-1075). `GITHUB_CHECKS` goes
from one entry to eleven, absorbing the ten predicates that lived as regexes in
pome-cloud's `deterministic/github.ts`. Minor, and it would be a major if these
packages were 1.x: the exported tuple changes shape and one exported type
changes meaning.

- Ten new declarations: `github.issue-exists`, `.issue-state`,
  `.issue-has-label`, `.issue-exactly-one-label`, `.issue-assignee`,
  `.issue-comment-contains`, `.pr-state`, `.pr-review-exists`, `.file-exists`,
  `.commit-status`.
- **Every check names its repository.** The regexes took `in owner/repo` as an
  OPTIONAL qualifier and, absent it, scanned repositories first-match-wins — so
  in a two-repo world a criterion silently graded whichever sorted first. Under
  a picked check the repo costs the author nothing, so the ambiguity is removed
  rather than documented.
- **`GitHubCheckStateIssue.labels` is `GitHubCheckStateLabel[]`, was `string[]`.**
  The old type was wrong: `exportState()` emits label ROWS. Nothing read it, so
  no verdict changes — but a check that had started reading it would have
  compared objects to strings and found nothing, forever.
- `github.issue-has-label-generic` is NOT ported. It existed only because free
  English arrives in more than one word order; nothing renders it now.
- `A REQUEST_CHANGES review exists …` no longer binds. The regex folded the
  review EVENT verb onto the API state `CHANGES_REQUESTED` because an author
  typing English could reach for either; under a picked check there is nothing
  to fold. The bundled tasks and examples are re-rendered accordingly.
- `github.commit-status` declares no vacuity mutant, where its regex had one.
  Typing the state as a closed set is right, and it costs this: a closed set has
  no guaranteed-false member, so no mutant can falsify it honestly. Recorded in
  `HONEST_NULL_MUTANTS` rather than papered over.
- Not here: `No unsupported endpoint was called` and the two `was never called`
  phrases. They read the call TAPE, and whether a check may is D1's open half
  (F-1076).
- Requires `@pome-sh/sdk@0.7.0` for `oneOf` and the vacuity sentinels.

## 0.3.0 — 2026-07-28

- `github.no-new-labels` declares a `description`: it compares the repository's
  label DEFINITIONS between the seed and the final state, so applying an
  already-defined label passes. That was a source comment; it is now readable
  by the authoring surfaces (F-1074).
- Requires `@pome-sh/sdk@0.6.0`, whose `CheckDefinition` makes `description`
  required. Minor for the same reason the sdk's is.

## 0.2.3 — 2026-07-28

Additive: `@pome-sh/twin-github/checks` declares `github.no-new-labels`
(F-1073), the twin's first assertable check, next to the state it reads.

Its predicate compares the repo's label DEFINITION set between the seed and
the final state. `addIssueLabels` rejects a label the repo does not define,
so `create_label` is the only operation that can grow that set. The rendered
sentence names the repo — ``No new labels were created in `acme/api`` — so a
reader hears the repo-scoped claim rather than the wider issue-scoped one the
bare phrasing invites.

Repins `@pome-sh/sdk` to 0.5.2 for the `./checks` subpath. No twin wire,
REST, or MCP surface change; `npm run test:contract` green.

All notable changes to the GitHub twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).

## 0.2.2 — 2026-07-21

Dependency-only patch: repin `@pome-sh/sdk` to 0.5.1 and
`@pome-sh/shared-types` to 0.12.0 (F-818). No twin surface change.

## 0.2.1 — 2026-07-20

Dependency-only release: repins the shared first-party contract to
`@pome-sh/shared-types@0.11.0` and the additive Gmail-capable engine to
`@pome-sh/sdk@0.5.0`. GitHub wire behavior is unchanged.

## 0.2.0 — 2026-07-16

Batches everything landed on main since 0.1.2 whose versions were never cut
(the publish workflow skips already-published versions, so npm 0.1.2 had gone
stale against the repo):

- #122 — FIDELITY.md re-cut by the heat rubric and the M5 hot gaps filled; the
  packaged MCP tool surface grows 62 → 65 (`pome twin start github` now serves
  the consolidated FDRS-648 surface from npm, matching the repo).
- #116 — structured fidelity inventory (`fidelity.inventory.json`) shipped as
  the machine-readable seam source of truth.
- #128 / #109 — `@pome-sh/sdk` pinned to 0.4.0: the twin self-generates
  `TWIN_AUTH_SECRET` on first non-loopback boot (`ensureTwinAuthSecret`).

Minor: the served REST/MCP fidelity surface changed shape.

## 0.1.2 — 2026-07-10

Dependency-only release for the node:sqlite driver swap (F-703):
`@pome-sh/sdk` pinned to 0.3.1 and the direct `better-sqlite3` dependency
dropped — the twin's install closure now has zero native modules. No twin
behavior changes.

## 0.1.1 — 2026-07-10

Dependency-only release: `@pome-sh/sdk` pinned to 0.3.0 (durable write-through
recorder) so the CLI bundle resolves a single sdk copy. No twin behavior
changes.

## 0.1.0 — 2026-07-09

First npm-published release (F-714).

A deterministic GitHub twin for agent testing — REST + MCP surfaces (repos,
issues, pull requests, reviews, collaborators, checks) over SQLite-backed
state, gated by the same push-access rules as the live API. Built as a thin
`@pome-sh/sdk` plugin (F-682): the twin declares its domain, tools, and
GitHub's frozen wire shapes; the engine owns HTTP mounting, bearer auth, the
recorder, MCP dispatch, and the admin gate.

### Added

- `twin-github` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- GitHub REST + MCP tool surface with push-access-gated mutations and
  fidelity-annotated behavior (see `FIDELITY.md`).
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `GITHUB_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry point `createGitHubCloneApp` for in-process embedding (used
  by the `pome` CLI's `--local` harness).
