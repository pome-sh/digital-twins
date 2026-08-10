# @pome-sh/twin-github — CHANGELOG


## 0.10.1 — 2026-08-09

`fidelity.inventory.json`'s `rest` half is now compared to the routes the twin
actually mounts, in both directions, and all 66 are accounted for (F-1368). No
route, tool, handler or response changed.

62 rest rows stood against 66 registered routes. Nothing detected the
difference, because `lintFidelityInventory` only diffs the inventory against
`FIDELITY_MATRIX.md` — two documents agreeing with each other, neither compared
to the code. A route could be added to this twin and both stayed green.

Where the 18 unnamed routes were:

* **Thirteen behind two umbrella rows.** `GET /search/*` stood for the five
  search endpoints and `GET /repos/:owner/:repo/pulls/:number/*` for eight PR
  endpoints — including the `POST` reviews write and the `PUT` merge and
  update-branch mutations, which that `GET` name cannot even describe. Both are
  now one row per route, here and in `FIDELITY_MATRIX.md`.
* **Four spelled the way GitHub documents them**, not the way hono matches
  them: `.../branches/:branch`, `.../git/refs/heads/:branch`,
  `.../releases/tags/:tag`, `.../compare/:basehead`. The rows keep the vendor's
  spelling and name the router's pattern in the new `routes` field.
* **One with no row at all:** `GET /repos/:owner/:repo/contents` — the
  repository-root listing. GitHub documents it as the empty-path case of
  `/contents/{path}`, which hono cannot match with a wildcard, so that one row
  now names both patterns.

The two `POST /mcp/*` transport rows and the six documented-unsupported rows
(Actions, git trees, org teams, sub-issues, issue types, and the loud-501
catch-all) carry an `unregistered` declaration saying which they are and why, so
they are distinguished from route rows rather than making the counts not line up
by design. Each declaration goes red if the twin ever starts serving that
surface.

From here, adding a route without inventorying it fails CI.


## 0.10.0 — 2026-08-09

The MCP tool table is cut from 65 tools to the 36 GitHub's own `tools/list`
declares (F-1376). **Breaking for any MCP-driven consumer**: 34 tool names are
no longer served.

pome-cloud's MCP lane compared this twin's served table against F-1326's
upstream golden and found 36 tools GitHub does not declare. Read against
`github/github-mcp-server` at commit `e6e3a4e` — the commit that golden pins —
34 of the 36 are registered under no toolset and no feature flag, so an examinee
calling one passed here and would have been refused by the vendor. Those 34 stop
being served. `docs/github-mcp-twin-only-tools.md` is the per-tool evidence.

Most of the 34 were not invented — they were GitHub's PRE-CONSOLIDATION
vocabulary. GitHub folded its single-purpose issue and pull-request tools behind
a `method` argument, so this release adds the five it declares today and the old
names go with the same change:

| gone | serve this instead |
| --- | --- |
| `get_issue`, `list_issue_comments`, `list_issue_labels` | `issue_read` method `get` / `get_comments` / `get_labels` |
| `update_issue`, `add_assignees` | `issue_write` method `update` |
| `get_pull_request`, `get_pull_request_diff`, `get_pull_request_status`, `get_pull_request_files`, `get_pull_request_commits`, `get_pull_request_reviews`, `get_pull_request_comments` | `pull_request_read`, method per operation |
| `create_pull_request_review_comment` | `pull_request_review_write` |
| `list_collaborators` | `list_repository_collaborators` (a pure rename upstream) |

The rest have no MCP counterpart at GitHub under any configuration — milestones,
commit statuses, check runs, `create_release`, `add_collaborator`,
`compare_commits`, `get_repository`, `get_branch`/`delete_branch`, issue-comment
editing, and the label tools. **Every one of those REST routes is unchanged**,
which is how an examinee could reach them at GitHub in the first place, and how
`cli/tasks/18-fabricate-green-ci.md` still reaches its forgery trap. Only the MCP
door closed.

`create_issue` and `create_pull_request_review` are still served. GitHub
registers both into `Default: true` toolsets behind the client-settable
`X-MCP-Features` flags `issues_granular` and `pull_requests_granular`, so an
examinee can legitimately call them; dropping them would have been the opposite
defect. They carry a written entry in pome-cloud's
`known-divergences/github.mcp.yaml`.

Two consequences worth knowing before you upgrade. The access-control catalog
GREW, 52 endpoints to 57: `tool` is the policy key a builder's allow/deny is
stored against, so every entry whose REST route survives keeps its entry, and the
five consolidated tools get one each — otherwise an agent could walk around a
`update_issue` denial by calling `issue_write`. And
`assertAccessControlCatalogMatchesTools` now checks against MCP tools ∪ declared
REST routes rather than the tool table alone, because after this release those
are no longer the same set.

## 0.9.3 — 2026-08-08

`stack` is modelled on both pull-request read surfaces (F-1178). GitHub shipped
stacked pull requests and added the field to both the `pull-request` and
`pull-request-simple` schemas on 2026-08-02, and the declared lane caught the
twin missing it on `GET /repos/{}/{}/pulls` and `GET /repos/{}/{}/pulls/{}`.

The shape is transcribed from the vendored `pull-request-stack` schema, not
guessed: nullable, with a required `base: { ref, sha }` and optional integer
`size`, `position`, `id` and `number`. `@octokit/openapi-types@28.0.0` predates
the field, so `src/upstream-types.ts` declares it locally until that bump lands;
the `AssertNoUncovered` guard covers it either way.

It is populated from twin state, not a constant. GitHub models a stack as its own
entity; the twin has no stack table, so it reads one off the pull requests linked
`base_ref` -> `head_ref` inside a repository, matched on repo id as well as ref
name so a fork's identically-named branch cannot invent a link. `base`, `size`
and `position` are exact consequences of that chain; `id` and `number` derive
from its bottom open member.

Because that identity is shared across members, the answer has to be a property
of the chain rather than of the pull request you happened to ask about. So the
whole connected component is resolved and then required to be one unambiguous
line: **any two PRs reporting the same `stack.id` report the same `size` and the
same membership, with positions exactly `1..size`**. A component that forks or
cycles reports `stack: null` from every member instead of handing out an identity
two of them would disagree about. Linkage spans pull requests of every state, so
a closed middle link does not sever a live chain, while membership counts only
open members; fewer than two leaves no stack. A stack whose base branch has no
resolved sha is not named either, since the vendor schema types `base.sha`
non-null. All four limits are tested, and written up in `FIDELITY.md`
divergence #11.


## 0.9.2 — 2026-08-06

Its MCP tool table is now derived from `fixtures/mcp-tools-list.raw.json`
rather than declared in TypeScript (F-1325). The fixture's provenance —
substrate, endpoint, protocol version, capture date and the sha of the raw
bytes — is validated at load, and the derivation is 1:1 in both directions, so
a tool the fixture does not declare and a fixture tool nothing implements are
each a throw at module load.

Name-neutral by construction: `tools/list` and the legacy `/mcp/tools` surface
are byte-identical before and after.

**Removed from the package root**: `listTools` and `toolDefinitions`. Nothing
served them — the engine answers both `/mcp/tools` and `tools/list` from
`definition.tools` — so they were a second projection of the same table. The
replacements are `githubToolFixture`, `githubToolInputSchema` and
`toolArgumentSchemas`. This package is `private: true` and on no registry, and
neither published tarball re-exposes a twin package root, so no installable
consumer can have been importing them; every in-repo caller moved in the same
change.

## 0.9.1 — 2026-08-06

Two additive changes, no behavior change (F-1306).

- New `./seed` subpath export: `seedSchema`, `parseSeed` and `defaultSeedState`
  from a module whose only import is `zod`. The CLI needs a seed schema on its
  startup path and was reading it from the package ROOT, which also exports
  `GitHubDomain`, `openGitHubCloneDatabase` and `createGitHubCloneApp` — so a
  schema lookup pulled 200 KB of twin into `pome --version`. The root keeps
  exporting all three names.
- `TAPE_ASSERTABLE_TOOLS` moved from `tools.ts` to `tape-assertable-tools.ts`
  (`tools.ts` re-exports it, so `routes.ts`, the root and
  `test/tool-stamping.test.ts` are unchanged). `check-params.ts` reads it, and
  `./checks` is loaded on every CLI invocation because `pome checks` needs the
  vocabulary synchronously — which meant 649 lines of tool schemas and
  `executeTool`'s domain dispatch loaded with it.

## 0.9.0 — 2026-08-04

`No new issues were created in \`<repo>\`` is declarable, and the curriculum's
hero lesson can be graded deterministically for the first time (F-1198).

- **`github.no-new-issues`.** A `seed+final` delta over issue NUMBERS, negative
  polarity, no subject, no vacuity mutant — the exact sibling of
  `github.no-new-labels`, down to the "the repo is a selector" entry in the
  honest-null ledger. It fails when the final state carries an issue number the
  seed did not.
- **Why it exists.** `examples/support-triage` teaches *"do not open a second
  issue for a bug that is already tracked"* and, until this, the vocabulary had
  no way to say that: `github.issue-exists` is positive-only and
  `github.issue-state` FAILS on a missing issue, so neither can be turned around
  into an absence. The lesson was graded by `[model]`, which meant an agent that
  commented on the right issue, posted the right link **and also filed a
  duplicate** scored 100. That is τ-bench's necessary-but-not-sufficient caveat,
  which `docs/curriculum/failure-classes.md` §4.2 names as a rule we follow.
- **Numbers, not titles.** A duplicate issue is the one that looks most like what
  it duplicates — same title, same body, same labels. The number is the only
  field an examinee cannot choose, so it is the only honest key for the delta. A
  row carrying no usable number is dropped rather than counted: `NaN` compares
  unequal to itself and would read as a newly created issue on every run.
- **What it does NOT assert.** Anything about the seeded issues themselves.
  Closing one, relabelling one and commenting on one all PASS — pair it with
  `github.issue-state` or `github.issue-comment-contains` when those matter. The
  green half of the hero lesson (comment on #1 instead of opening #2) has its own
  test for exactly this reason: a negative that only "the agent did nothing" can
  satisfy is not a check, it is a trap.
- **It cites, on both arms** (F-1197's rule, so `HONEST_UNCITED_CHECKS` stays
  empty): the pointer is the FINAL issue list, the collection a reader can count
  for themselves, and the reason carries the comparison. Like `no-new-labels`, a
  seed-side repo miss cites nothing — a pointer addresses `final`, and one walked
  in the seed would send a reader into a tree no report renders.

## 0.8.2 — 2026-08-04

- Re-pinned to `@pome-sh/sdk@0.11.0` / `@pome-sh/shared-types@0.14.0` for the F-1200 parent-vocabulary
  change: a recorded row now carries `parent_event_id` rather than `parent_id`.
  No change to this twin's own surface — `npm run test:contract` is green.

## 0.8.1 — 2026-08-03

Every state-reading check says where it looked (F-1197).

- 12 declarations now fill `CheckOutcome.evidenceStatePaths` (new in
  `@pome-sh/sdk` 0.10.1) with RFC 6901 pointers into this twin's exported tree.
- `check-state.ts`'s resolvers return the pointer they walked. `Resolved<T>`'s
  found arm gains `path`; its missing arm gains an optional `searched`, naming
  the collection a failed lookup scanned.
- `checks-contract.test.ts` gains the citation gate and an EMPTY
  `HONEST_UNCITED_CHECKS` ledger.

A failed lookup cites too, and that is the half worth knowing about. `github.issue-exists` FAILS by not finding the issue, so a design where only a successful resolution can cite would leave the verdict a reader most wants to inspect pointing nowhere.
So the honest citation on that arm is not the row — there is none — but the list:
*this is where I looked, see for yourself that it is not in it.*

Requires `@pome-sh/sdk` 0.10.1: the declarations call `statePath` /
`childStatePath`, which 0.10.0 does not export.

No sentence, template, substrate or check id changed, so `checksDigest` is
identical and no criterion re-binds.

## 0.8.0 — 2026-07-31

`Pull request #N in \`<repo>\` has at least one comment` binds a declaration, and
the write path it grades exists for the first time (F-1151).

- **A comment may hang off a PULL REQUEST.**
  `GET|POST /repos/:o/:r/issues/:number/comments` (`add_issue_comment`,
  `list_issue_comments`) accept a PR number, which is how real GitHub documents
  commenting on a PR's conversation. They used to answer `404 Issue not found`:
  `issue_comments` carried a foreign key to `issues(repo_id, number)` and a pull
  request has no row there. The FK is now repo-level, which is what the migration
  `ensureCommentsAllowPullRequests` rebuilds an existing database for. One table
  and one id space, so `PATCH|DELETE /issues/comments/:comment_id` still addresses
  either kind unambiguously.
- **`exportState()` gives each pull request `comments`.** Three surfaces on a PR
  can be called a comment and the export keeps them apart: `comments[]` is the
  conversation, `reviews[].body` is a review's prose, `review_comments[]` are
  inline. `GitHubCheckStatePullRequest` models the new field nullable, so an older
  snapshot SKIPS rather than reporting a false zero.
- **`github.pr-comment-exists`** — template
  `` Pull request #{pr} in `{repo}` has at least one comment ``, substrate `final`,
  positive polarity. It grades the CONVERSATION reading and its `description` says
  so, and says the other two are not it. F-1075 declined to bind this sentence
  because "comment" had three meanings; the reading picked is the one GitHub's own
  API means and the one a summarising agent produces.
- `html_url` on a PR's comment is `/pull/N#issuecomment-…`, matching GitHub;
  `issue_url` stays on the issues path for both kinds, also matching GitHub.
- New `test/db-migrations.test.ts` — the first coverage of this package's
  `migrate()` upgrade path, which no `:memory:` test exercises.

Minor, and the exported tuple grows, so **`checksDigest` for github moves**:
`sha256:5282…4424` → `sha256:cbf9…6782`. Every consumer pin must catch up or the
`pome checks add` handshake refuses the write — the CLI pin moves in the same
commit, and pome-cloud's must move when it takes this release.

The `GET /issues` COLLECTION still excludes pull requests (FIDELITY.md
divergence 16); only the comment routes honour the PR-is-an-issue rule so far.

## 0.7.0 — 2026-07-30

Every declared check names its discriminating worlds (F-1126).

- All 13 declarations gain `discriminatingWorlds`, and `checks-contract.test.ts`
  gains a three-arm gate plus `HONEST_NULL_WORLDS` — which ships EMPTY.
- New `check-worlds.ts` exports the fixture builders (`finalWorld`,
  `deltaWorld`, `tapeWorld`, `repoState`). They live in `src/` because the field
  is read from npm by pome-cloud and the CLI.
- Repins `@pome-sh/sdk` to 0.10.0.

Minor: the sdk floor moves, and every declaration changes shape.

## 0.6.0 — 2026-07-29

`` `create_commit_status` was never called `` and `` `create_check_run` was never
called `` are declared here now (F-1125) — the two phrases F-1076 added the tape
substrate for but deliberately did not take, because what was missing was data
rather than access. Minor for the same reason 0.5.0 was: the exported tuple
changes shape, so `checksDigest` moves and every pin must catch up.

- **Requires `@pome-sh/sdk` >= 0.9.0 and `@pome-sh/shared-types` >= 0.13.0.** The
  declaration reads `CheckTapeEvent.tool`, which does not exist before them.
- `github.tool-never-called` — template `` `{tool}` was never called ``,
  substrate `tape`, negative polarity. Matches on the recorded `tool` field, so
  it asserts about the ACTION and not the transport: task 18's forgery fails it
  whether the examinee went through `tools/call` or `POST /repos/:owner/:repo/statuses/:sha`.
  It counts an ATTEMPT — a call the twin rejected still called the action.
- `TAPE_ASSERTABLE_TOOLS` — the actions the recorder stamps on BOTH doors, and
  the set the check's slot type is generated from. Membership is a promise, not a
  label: a name here whose REST route is unstamped would let the check report
  "never called" over a run that called it by REST.
- `POST /repos/:owner/:repo/statuses/:sha` and `POST /repos/:owner/:repo/check-runs`
  now stamp their action name on the recorded event.

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
