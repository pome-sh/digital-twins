# @pome-sh/twin-github — CHANGELOG

## 0.10.9 — 2026-08-12

A wrong `sha` on the contents door is a **409**, not a 422, and a missing one
names the field the way GitHub names it (F-1491).

**The 409 was a hypothesis on the ticket and it measured true — three ways.**
Probed live against two throwaway private repos on 2026-08-12: a `sha` that is
not a sha (`deadbeef`), a well-formed 40-hex sha that exists nowhere, and the
real sha of a *different* blob all get the same `409 <path> does not match <sha>`.
GitHub draws no line between malformed and stale, so neither does this twin. The
message names the full path (`dir/sub/file.txt does not match …`), not the
basename, and the body carries **no `errors` array** — where this twin previously
sent `422 Validation Failed` plus a structured one. `DELETE /contents/*` answers
the same two shapes against its own doc anchor. GitHub's published OpenAPI
description declares the same 409 against `basic-error`, independently of the
wire measurement.

**A missing `sha` stays 422 but stops being generic.** GitHub answers
`Invalid request.\n\n"sha" wasn't supplied.`, with no `errors` array — measured on
four unrelated surfaces (`PUT`/`DELETE /contents/*`, `POST /issues`,
`POST /pulls`), so it is GitHub's general answer to any missing required body
field. `PUT /contents/*` adopts it, because that refusal is raised by the domain.

**Two things this deliberately did NOT change.** `DELETE /contents/*` with no
`sha` at all still shows the generic `Validation Failed`, because its declaration
requires `sha` and zod refuses before the domain is reached; migrating that means
changing the zod branch for every required field on every route, which is a global
envelope change and is now divergence 30. And the already-exists family keeps its
`errors` array, which is right — GitHub sends one there, measured on `POST /labels`
and on `POST /pulls` with `head == base`. The shared `validationFailed` helper is
untouched on all 48 of its other call sites, with a test that says so.

**Two cases the twin already had right, now guarded rather than incidental**: a
`sha` sent for a path that does not exist is *ignored*, and the write succeeds
with 201 — GitHub never looks at it, so validating there would refuse writes
GitHub accepts; and a nonexistent `branch` is checked before the `sha`.

## 0.10.8 — 2026-08-12

`PUT /contents/*` takes base64, the MCP write tools keep taking plain text, and
divergence 24 is retired (F-1460).

**The REST route base64-decodes `content` and refuses what GitHub refuses.**
F-1389 removed the `encoding` switch from the declaration and left the behaviour
alone; this closes it. Invalid base64 now gets real GitHub's answer, measured
live against the API on 2026-08-12 rather than assumed: HTTP 422,
`content is not valid Base64`, **no `errors` array**, and the operation-specific
`documentation_url`. What GitHub validates is STRUCTURE — the base64 alphabet and
a padded length, whitespace tolerated anywhere — not meaning: `test` is well
formed, so GitHub takes it and writes three junk bytes, and so does this twin.
`abcde` is not, and both refuse it.

**The MCP door was already right, and the ticket that opened this was wrong
about it.** F-1460 was written to make `create_or_update_file` and `push_files`
decode base64 too, on the reasoning that the reachable door must not be left
behind. The measurement says the opposite: GitHub's own MCP server takes
`content` as PLAIN TEXT and base64-encodes it itself before calling the REST
route, and its tool schema tells the model so outright — *"Do not base64-encode
it; this server does that before calling the REST API."* `push_files` hands
`content` to a Git tree entry, which takes plain UTF-8 as well. So the doors are
asymmetric because GitHub's are, the decode lives at the REST boundary
(`src/rest-content.ts`) and never in the domain that serves both, and
`test/contents-base64.test.ts` carries two tests whose only job is to fail if a
later change "unifies" them.

**The migration was 13 call sites, not 47.** The 47 in the ticket counted every
mention of `content`; split by door it is 13 REST calls (all inside this
package's own suite, all migrated here), 22 MCP calls that are correct as they
stand, and 36 direct domain calls that sit below both doors. The default seed
needed nothing either — it commits through `commitFiles` and never touches the
decode path. **Zero shipped tasks under `cli/tasks/` write file content**, so no
saved task's expected output moves.

**`encoding` is gone from the MCP validators too.** It survived F-1389 because
the served tool table is a capture and the zod validators are a different object;
`mcp-argument-surface`'s known-residue entry for it is retired with it.

**Divergence 24 retired; 29 recorded in its place.** Accepting base64 makes a
limitation reachable that nothing could express before: `files.content` is a TEXT
column, so bytes that are not valid UTF-8 come back as replacement characters.
Recorded rather than fixed — closing it means changing the storage convention for
every surface that reads file content back out.

## 0.10.7 — 2026-08-12

`updated_at` appears on release objects, and four divergences the first real
comparison of the seeded collections found get written down (F-1459).

**Releases carry `updated_at`.** Real GitHub returns it on every release and this
twin omitted the key entirely, so all three release surfaces —
`GET /releases`, `/releases/latest`, `/releases/tags/:tag` — reported
`field-removed` against the real-GitHub golden. A release here has never been
edited (there is no release-update route on this twin), so its update instant is
its creation instant and the honest value was already in hand; omitting it was a
gap, not a modelling decision. `updated_at` is a real column rather than
`created_at` aliased in the serializer, so that a release-update route added
later has somewhere to write and cannot silently leave this field frozen.
Databases written by an earlier build migrate through `ensureColumn` and are
backfilled from `created_at`, which is exact rather than approximate for the
same reason.

**Four divergences recorded, not fixed** — bullets 25–28 in FIDELITY.md. None of
these is new behaviour. Seven of this twin's collections published `green` from
2026-05-31 while both sides of the comparison were empty arrays, which bound no
key, no leaf type and no element; seeding the upstream half made the comparison
real, and this is what it found.

- **25** — issue-comment objects omit `author_association`, `reactions`,
  `performed_via_github_app`, `pin` and `minimized`.
- **26** — review objects omit `author_association`.
- **27** — release objects omit GitHub's `immutable` flag. Unlike its neighbour
  `updated_at` there is no honest value to emit: this twin does not model
  immutable releases, and a hard-coded `false` would claim it had evaluated
  something it cannot.
- **28** — a review comment's `pull_request_review_id` is always `null`. The
  faithful fix is for this twin to mint the implicit `COMMENTED` review GitHub
  makes for a standalone review comment, but the fidelity harness already works
  around the gap by declaring that review in its seed — so minting one here
  would serve three reviews where GitHub serves two. Both moves have to land
  together, across two repos, and that is its own change.

## 0.10.6 — 2026-08-11

Nine route inputs GitHub does not declare come out of `route-inputs.ts`, and
the search routes learn the `q` qualifiers GitHub puts them in instead (F-1389).
The published input surface goes 295 → 286.

**`GET /search/code`, `/search/commits` and `/search/issues` take `q` and
nothing but `q`.** GitHub's search API has ONE scoping input and encodes every
filter as a qualifier inside it (`repo:octocat/hello-world`, `state:open`); its
OpenAPI declares `q, sort, order, per_page, page`. This twin also took `?owner=`,
`?repo=` and `?state=` — seven inputs across the three routes — and scoped by
them, so the same request was scoped here and unscoped on GitHub.

Both halves of that had to move together, because the second one is worse than
the first. `q` was matched as ONE case-insensitive substring, so an agent writing
the request GitHub actually documents:

```
GET /search/issues?q=idempotency repo:acme/api
```

got **zero results** — no issue's title or body contains that literal string.
The surface did not merely let a wrong scoping habit pass; it punished the
correct one, and deleting the three parameters alone would have left that
standing. So `domain/search.ts` now lifts four qualifiers out of `q` —
`repo:owner/name`, `user:login`, `org:login`, and `state:open|closed` on
`/search/issues` — scopes by them, ORs several together the way GitHub does,
and matches whatever free text is left as the substring term. The parser sits in
the domain, so the MCP tools get it too.

A qualifier this twin does not parse (`in:`, `language:`, `path:`, `is:`, a
typo) stays in the free-text term rather than being dropped: dropping it would
answer a BROADER set than GitHub for a request GitHub narrows, and breadth is
the direction that scores a call the real API would not have served. Same for a
recognised qualifier carrying a value the surface cannot honour — `repo:api`
with no owner, `state:merged`. FIDELITY.md divergence 1 lists what is and is not
parsed; `test/search-query-qualifiers.test.ts` pins it.

⚠️ **`?state=` on `/search/issues` no longer filters.** It is ignored, not
refused. A caller who relied on it gets the unfiltered answer — spell it
`q=… state:closed` instead. Nothing changed about the absence of a `state=open`
DEFAULT on that route (F-1427); only the spelling of the explicit filter moved.

Two more, unrelated to search:

- `owner` off the `POST /user/repos` body. That surface creates a repository for
  the AUTHENTICATED USER, which is its whole meaning, and
  `repos/create-for-authenticated-user` declares 23 body properties without it.
  `routes.ts` passed the body straight to `domain.createRepository`, so the one
  surface defined not to take an owner could be made to create a repository
  under an arbitrary one. It stays declared on `POST /orgs/:org/repos`, where
  the handler overwrites it from the path and nothing observable differs.
- `encoding` off `PUT /repos/:owner/:repo/contents/*`. GitHub declares `content`
  as base64 and takes no `encoding` parameter.

All nine are now undeclared, so github's measured `ignore` disposition (F-1372)
discards them instead of the handler acting on them. None is a 4xx: real GitHub
answers 200 to a parameter it does not know.

⚠️ `encoding`'s BEHAVIOURAL half is recorded, not fixed — the twin still treats
`content` as plain text where GitHub treats it as base64. New FIDELITY.md
divergence 24 says so, with the measurement that deferred it: 47 call sites send
`content` and zero send base64, and the MCP door still declares `encoding`.

The MCP door keeps `owner` / `repo` on `search_code` and `search_commits` and
`state` on `search_issues`. Those are a separate published surface with their
own frozen tool fixture, and they are left alone here on the same line the
`encoding` amendment drew — the qualifier parser reaches both doors, so an MCP
caller writing `repo:acme/api` inside `query` is served correctly either way.


## 0.10.5 — 2026-08-11

`pull_request_read`'s `get_comments` reads the PR's conversation instead of its
inline review comments (F-1423).

The dispatch answered BOTH comment methods from `pull_request_review_comments`:

```js
// GitHub distinguishes issue-level `get_comments` from diff-level
// `get_review_comments`; this twin stores one comment thread per PR and
// answers both from it rather than inventing a split it does not model.
case "get_comments":
case "get_review_comments":
  return domain.getPullRequestComments(pull);
```

The justification was false by the time it was read. F-1151 gave a PR's
conversation its own storage — `issue_comments`, keyed on the PR's own number,
because GitHub models a pull request as an issue — and F-1421 gave the seed both
vocabularies as separate fields (`pull_requests[].comments[]` and
`pull_requests[].review_comments[]`). The twin models the split; only this
dispatch did not. `get_comments` now reads `issue_comments` and
`get_review_comments` keeps the review-comment table.

The conversation is read through a new `getPullRequestConversation`, not by
calling the ISSUE endpoints' `listIssueComments` with the pull number. Those
read the same rows through the same serializer, but they resolve the target
with `requireCommentTarget`, which accepts an issue OR a pull request — correct
for the endpoints it serves, and wrong on this tool, where every other method
answers 404 for a number that is not a pull request. Reusing it would have
fixed the table and quietly widened one method of `pull_request_read` to answer
for issues as well.

⚠️ **This changes what the twin SERVES.** An examinee calling
`pull_request_read(method: "get_comments")` gets the PR's discussion from 0.10.5
on, where it previously got inline diff comments — and, since 0.10.3 (F-1422),
got them in the full review-comment shape, so the answer was recognizably the
wrong OBJECT rather than a lean one that could pass for a timeline comment. A
task that seeded review comments and read them back through `get_comments` will
now see `[]` unless it also seeds `comments[]`. The REST routes are unchanged;
this was always MCP-only, which is why no fidelity lane measured it — the L1 MCP
lane compares tool names and input schemas, not response bodies.

`test/pull-request-read-comment-methods.test.ts` seeds one comment of each kind
on one PR and pins each method to the body its own table holds, asserts the two
answers are disjoint, and pins `pull_request_read(get_comments)` equal to
`issue_read(get_comments)` on the same number — the two tool names for the one
GitHub endpoint, which is what stops the dispatches drifting apart again.


## 0.10.4 — 2026-08-11

An absent `state` means `open` on the three list routes, the way real GitHub
documents them (F-1427).

`GET /repos/:o/:r/issues`, `GET /repos/:o/:r/pulls` and
`GET /repos/:o/:r/milestones` each filtered only when `state` was PRESENT:

```js
if (input.state && input.state !== "all") rows = rows.filter(...)
```

so a caller who sent none — the common case, and the one real GitHub answers with
open items only — got everything, closed included.

⚠️ **This changes what the twin SERVES.** A task whose agent lists issues and
counts them gets a different answer from 0.10.4 on. That answer is the one real
GitHub gives, but it is a moved result, not a silent correction. `state=all`
returns everything and an explicit `state=closed` returns the closed items; both
are unchanged.

It stayed invisible for one reason on all three surfaces: every seeded issue,
pull request and milestone was open, so `all` and `open` named the same set and
no fixture could tell them apart. pome-cloud's upstream seeder had already met
the milestone half and worked around it in the SEED rather than the twin — its
milestone is kept open on purpose, commented "GitHub defaults that list to
`state=open` — a closed milestone would leave the golden empty again". The issue
half surfaced the moment pome-cloud's fidelity seed closed an issue, as
`[].state` constant-mismatch and `[].closed_at` type-changed against real GitHub,
both CRITICAL on a `semantic`-tier read surface.

`GET /search/issues` is deliberately excluded and now says so in the code.
GitHub's search API has no `state` default — `is:open` is a query qualifier, not
a default — so the twin's search keeps filtering only on an explicit `state`.
Imposing the list default there would be a new divergence in the other direction,
and a worse one: the twin's search is substring matching over the seeded world,
so a query whose only match is closed would answer `[]`, replacing a value
mismatch with an empty-array one.

Seeding the closed side of these surfaces works now, too. `seedSchema` had
accepted `pull_requests[].state` for as long as the field existed, but nothing
ever applied it — `createPullRequest` hardcodes `'open'` in its INSERT — so a
seed asking for a closed pull request got an open one and
`GET /pulls?state=closed` could not be made non-empty by any seed. That is the
same shape of invisibility F-1421 fixed for the five entities the seed could not
express at all, and it is why the pull-request half of this fix was untestable
until now. The seed applies it last, after every child is seeded: the review and
update-branch write paths refuse a non-open pull request, so closing first would
make a seeded child fail against the state the seed itself asked for.

`test/list-state-default.test.ts` seeds one open and one closed of each kind and
compares SETS of numbers, never counts — a count matches for the wrong reason as
easily as the right one, since two items is what `state=all` returns AND what an
open default would return from a world with two open items. The absent case is
asserted equal to the explicit `open` case and, separately, NOT equal to the
`all` case, so a future change that reverts the default fails on the assertion
that names the cause.


## 0.10.3 — 2026-08-10

`GET /repos/:o/:r/pulls/:n/comments` serves the review-comment object, not six
columns of it (F-1422).

The LIST route built its elements inline — `{id, path, body, user, created_at,
updated_at}` — while `POST` to the same route served the SAME ROW through
`pullRequestReviewCommentJson`, which carries `line`, `side`, `commit_id`,
`pull_request_url`, `position`, `html_url`, the `original_*` twins and the rest.
The write path validates `line` against the target file's real line count and
refuses one past the end; the read path then dropped the value it had just
checked. One row had two shapes depending on which verb you used, and the read
side — the one a fidelity lane measures and an agent reads — was the lean one.

The fix is one line of routing: the LIST maps through the same serializer the
CREATE uses. `listPullRequestReviewCommentRows` also stops casting a `SELECT *`
to a six-key structural subset of `PullRequestReviewCommentRow` — that cast is
what made the omission look deliberate to every reader after it.

What this means for a caller:

- `GET /repos/:o/:r/pulls/:n/comments` elements gain `url`, `node_id`,
  `pull_request_review_id`, `diff_hunk`, `position`, `original_position`,
  `commit_id`, `original_commit_id`, `in_reply_to_id`, `side`, `line`,
  `original_line`, `start_line`, `original_start_line`, `start_side`,
  `html_url` and `pull_request_url`. The six they already had are unchanged.
- `pull_request_read`'s `get_review_comments` and `get_comments` answer from the
  same domain call, so both widen with it.
- Nothing narrows, and no other route, tool or handler moved.

This was invisible rather than merely wrong, which is why it survived: the
surface answered `[]` on every seed anyone could write until 0.10.2 (F-1421)
made a review comment seedable, and a shape-diff compares no elements when
either side is empty. The first real element on this surface is what makes an
omitted field a `field-removed` finding — drift, on a `semantic`-tier read
surface.

`test/review-comment-list-shape.test.ts` states the property that was violated
rather than a field checklist: the LIST element and the CREATE response are the
same object for the same comment. A checklist goes stale the next time the
serializer grows a leaf; the property does not. It also plants a wrong `line` —
two worlds differing only in the seeded anchor — so the new fields are shown to
be COMPARED and not merely present. A field that is serialized but never
compared publishes green whatever it holds, which is the same defect one level
over.

FIDELITY.md divergence 21 changes subject accordingly: it recorded the two
shapes as an open gap and now records what is genuinely absent from the one
shape versus real GitHub — `author_association`, `reactions`, `subject_type` —
plus the two the twin serves as placeholders rather than measurements
(`diff_hunk`, `position`). The matching `read_subset` entry lives in pome-cloud's
`known-divergences/github.yaml`; without that cloud-side half the daily cron
still reds, because a `FIDELITY.md` bullet alone relaxes no verdict.


## 0.10.2 — 2026-08-10

The seed can name a milestone, a tag, a release and a comment, and the twin
serves them (F-1421). No route, tool, handler or response shape changed.

`seedSchema` had no field for five of the entities this twin SERVES —
milestones, tags, releases, issue comments and pull-request review comments —
and zod strips unknown keys, so a seed naming one arrived at the domain as
nothing at all. `GET /repos/:o/:r/milestones`, `/tags`, `/releases`,
`/issues/:n/comments` and `/pulls/:n/comments` could only ever answer `[]`, on
every seed anyone could write. The tables, the domain operations and the routes
were all already there; the seed was the only thing that could not reach them.

That is worse than wrong, it is invisible: a shape-diff returns before the
per-element comparison when EITHER side is empty, so `[] vs []` compares zero
elements and publishes green. Those five surfaces had been publishing green
against an equally empty golden since 2026-05-31, and F-1420 — which seeds the
upstream half — would have turned that vacuous green into an equally vacuous
`array-length-changed` red without this change.

New seed fields, every one optional and defaulting to `[]`, so an existing seed
parses to the same value it did before and the default world does not move:

- `repositories[].milestones[]` — `{number?, title, description?, state?,
  due_on?}`. `number` is honored when given and assigned sequentially from 1
  otherwise.
- `repositories[].tags[]` — `{name, target?}`, `target` being any ref the twin
  resolves (a branch name or a SHA), defaulting to the default branch's head.
- `repositories[].releases[]` — `{tag_name, name?, body?, target_commitish?,
  draft?, prerelease?, author?}`. A release naming a seeded tag reuses it rather
  than minting a second.
- `repositories[].issues[].comments[]` and
  `repositories[].pull_requests[].comments[]` — `{body, author?}`. One shape,
  because it is one table and one route: GitHub serves a pull request's
  conversation through the issue-comment endpoints (F-1151).
- `repositories[].pull_requests[].review_comments[]` — `{body, path, line?,
  side?, author?}`, the inline surface.

Two things worth knowing about how they are applied.

**Review comments go through the domain's write path**, not a raw INSERT. So
`path` must name a file the pull request changes and `line` must exist in that
file: a seeded review comment is one `POST /pulls/:n/comments` could have
produced, and a seed planting one it could not FAILS rather than creating a row
only the seeder can make.

**Comment authors are seeded honestly.** `addIssueComment` stamps `user_login =
"pome-agent"` unconditionally, and an issue whose only commenter is the agent
under test is not an issue worth handing that agent — so the seed writes the
author directly, the same bargain the seeded PR reviews already struck for the
same reason.

`GET /releases/latest` and `GET /releases/tags/:tag` answer 200 from a seed as
of this version. Both are registered exceptions in pome-cloud's Level-1 coverage
list whose stated reason is "the seed schema cannot seed a release"; that reason
is now false, and the exceptions are retired alongside this change. An exception
list that outlives its reason starts lying.

`test/seed-entities.test.ts` runs each of the seven surfaces against TWO worlds
that differ only in the value the seed plants, asserting that the served element
carries THIS world's value and that the other world's differs. Asserting the
array came back non-empty would have been the same mistake one level up — it
passes against a twin answering a constant.

Two things this version does NOT change, named because it is what makes them
observable for the first time:

- `GET /pulls/:number/comments` serves a leaner element than the twin's own
  review-comment object — no `line`, `side`, `commit_id` or `pull_request_url` —
  while `POST` to the same route serves all of them from the same row.
- `pull_request_read`'s `get_comments` still answers from the review-comment
  table, on a comment says the twin "stores one comment thread per PR". F-1151
  gave the conversation its own table and `exportState` keeps the three apart,
  so that comment is stale and the method is pointed at the wrong one.

Both are served-shape questions with their own fidelity accounting, not the
modelling gap this version closes.


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
