<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cross-call state

**In about three minutes you will watch a twin keep books.** Three writes, each
read back through the twin's own surfaces, all three still there on a single
later read — and then the same read against a second sandbox of the same twin,
where none of them exist.

A mock answers from a script. A twin holds state. Those are different claims,
and this is the one that is measurable.

The property has two halves, and the second is the one that matters:

1. **State survives across calls inside one sandbox.** Call N's write is
   readable at call N+1.
2. **State does not survive across sandboxes.** A fresh mint of the same twin is
   a fresh world. Your run cannot leak into anyone else's, including your own
   next one.

Nothing here is graded, nothing needs an API key, and nothing burns an agent
eval. See [Cost](#cost).

## Prereqs

- A [pome](https://app.pome.sh) account.
- Your own coding agent (Claude Code, Cursor, …) — it drives everything below.
- Node with `npx`, plus `curl` and `jq` for the transcripts.

No `ANTHROPIC_API_KEY`. You are the only seat.

## Paste this to your agent

```text
Mint two Pome sandboxes on the github twin, one at a time, with
`npx @pome-sh/cli@latest sandbox create --twin github
--secrets-file <file> --format json`.

In the first: read issue #1 of acme/api, then make three writes — post a
comment, assign alice, close the issue — reading the state back after each
one. Then read the tape at GET <rest_url>/_pome/events and show me the rows
in order with their status and state_mutation.

In the second sandbox: read the same issue and the same comment list, and
show me that not one of the three writes is there.

Use curl against POME_GITHUB_REST_URL from each secrets file.
POME_AUTH_TOKEN is the bearer on every call; if a call comes back 404 when
you expected data, check the bearer before you debug the path. This is
ungraded: do not finalize anything, and keep your own evaluator and
observability setup. Stop both sandboxes with --discard when you are done.
```

Everything below is what you should see. Every output block is verbatim from a
real run — sandboxes `ses_gTgfTIGgoO4dgjZU` and `ses_qPk73MKVXnGjJr39`, prod,
2026-08-25.

Mint the first sandbox, and give it two shell variables so the rest of this
page stays readable:

```bash
npx @pome-sh/cli@latest login          # once
npx @pome-sh/cli@latest sandbox create --twin github \
  --secrets-file .pome-sandbox.env --format json | jq '{session_id}'

source .pome-sandbox.env
R="$POME_GITHUB_REST_URL"
A="Authorization: Bearer $POME_AUTH_TOKEN"
```

`sandbox create` writes the bearer, the session id and the per-twin REST base
into that file at mode `0600`. It expires in 30 minutes.

## The world

There is no `--seed` on this path, so the twin boots its own
`defaultSeedState()`. For the github twin that is one repo `acme/api` holding
one open issue, `#1`, labeled `bug`, unassigned, with no comments.

```bash
curl -s -H "$A" "$R/repos/acme/api/issues/1" \
  | jq '{number, title, state, comments, assignees: [.assignees[].login]}'
```

```json
{
  "number": 1,
  "title": "500 error on POST /orders after deploy",
  "state": "open",
  "comments": 0,
  "assignees": []
}
```

Three zeros to move: `state` is `open`, `comments` is `0`, `assignees` is empty.

## Half 1 — state survives across calls

Three writes, on three different surfaces of the same issue.

```bash
# write 1 — comment
curl -s -X POST -H "$A" -H 'Content-Type: application/json' \
  -d '{"body":"Repro: POST /orders 500s when the payload omits `currency`."}' \
  -w '%{http_code}\n' -o /dev/null \
  "$R/repos/acme/api/issues/1/comments"

# write 2 — assign
curl -s -X POST -H "$A" -H 'Content-Type: application/json' \
  -d '{"assignees":["alice"]}' -w '%{http_code}\n' -o /dev/null \
  "$R/repos/acme/api/issues/1/assignees"

# write 3 — close
curl -s -X PATCH -H "$A" -H 'Content-Type: application/json' \
  -d '{"state":"closed"}' -w '%{http_code}\n' -o /dev/null \
  "$R/repos/acme/api/issues/1"
```

```text
201
201
200
```

The read-back after write 1, through the twin's own comment surface — a
different endpoint from the one that wrote it:

```bash
curl -s -H "$A" "$R/repos/acme/api/issues/1/comments" \
  | jq -r '.[] | "\(.user.login): \(.body)"'
```

```text
pome-agent: Repro: POST /orders 500s when the payload omits `currency`.
```

Now the point of the whole exercise. **One** read, and all three writes are
there at once — a comment posted five calls ago, an assignee from three calls
ago, a state change from two:

```bash
curl -s -H "$A" "$R/repos/acme/api/issues/1" \
  | jq '{state, comments, assignees: [.assignees[].login]}'
```

```json
{
  "state": "closed",
  "comments": 1,
  "assignees": [
    "alice"
  ]
}
```

Three zeros became `closed`, `1`, `["alice"]`. Nothing was replayed and nothing
was cached — each write mutated a row that the next read resolved.

## Read the tape

The tape is the twin's own record of the run. There is no dashboard tape surface
for an ungraded sandbox, so this is the surface:

```bash
curl -s -H "$A" "$R/_pome/events" > tape.json
jq -r '.[] | [.method, (.path|sub("^/s/[^/]+";"")), .status,
  .state_mutation, .tool // "-"] | @tsv' tape.json | column -t
```

```text
GET    /repos/acme/api/issues/1            200  false  -
POST   /repos/acme/api/issues/1/comments   201  true   add_issue_comment
GET    /repos/acme/api/issues/1/comments   200  false  -
POST   /repos/acme/api/issues/1/assignees  201  true   -
PATCH  /repos/acme/api/issues/1            200  true   -
GET    /repos/acme/api/issues/1            200  false  -
```

**You should see:**

- **Six rows, in the order you made them.** The tape is ordered, not a set.
- **`state_mutation` true on exactly three of them** — the three writes, and
  none of the reads. This is a recorded boolean, not a guess from the HTTP
  method.
- **`add_issue_comment` stamped in the `tool` column** on the comment write.
  The other two writes read `-`: only three github action names are stamped
  today (see [Assertable checks](#assertable-checks)).
- **Every row `fidelity: "semantic"`** — a behavioural contract compared against
  a captured GitHub response, not a shape check. Add `.fidelity` to the `jq` to
  see it.

And the row that is the actual receipt for "the twin keeps books" — each write
row carries the before/after it caused:

```bash
jq -c '.[3].state_delta
  | {b: .before.assignees, a: .after.assignees}' tape.json
```

```json
{"b":[],"a":["alice"]}
```

Reads carry `state_delta: null`. Only the three writes carry a delta.

## Half 2 — and it does not cross sandboxes

Mint a second sandbox. Same twin, no `--seed`, so the same starting world.

```bash
npx @pome-sh/cli@latest sandbox create --twin github \
  --secrets-file .pome-sandbox2.env --format json | jq '{session_id}'
```

Read the same issue, with the second sandbox's own bearer:

```bash
source .pome-sandbox2.env
R2="$POME_GITHUB_REST_URL"
A2="Authorization: Bearer $POME_AUTH_TOKEN"

curl -s -H "$A2" "$R2/repos/acme/api/issues/1" \
  | jq '{state, comments, assignees: [.assignees[].login]}'
curl -s -H "$A2" "$R2/repos/acme/api/issues/1/comments" | jq -c
```

```json
{
  "state": "open",
  "comments": 0,
  "assignees": []
}
```

```text
[]
```

Back to three zeros. The issue is the same issue — same number, same title,
same `bug` label — and the comment, the assignee and the close are simply not
there.

The strongest form of this is not sequential. **Both sandboxes are alive at the
same moment**, and the same request against each returns a different world:

```text
{"sid":"ses_gTgfTIGgoO4dgjZU","state":"closed","comments":1,"assignees":["alice"]}
{"sid":"ses_qPk73MKVXnGjJr39","state":"open","comments":0,"assignees":[]}
```

So this is isolation, not a reset. Sandbox 1 still held its three writes while
sandbox 2 had never seen them.

The tape is per-sandbox too. Same command as before, pointed at sandbox 2:

```bash
curl -s -H "$A2" "$R2/_pome/events" > tape2.json
jq -r '.[] | [.method, (.path|sub("^/s/[^/]+";"")), .status,
  .state_mutation, .tool // "-"] | @tsv' tape2.json | column -t
```

```text
GET  /repos/acme/api/issues/1           200  false  -
GET  /repos/acme/api/issues/1/comments  200  false  -
```

Two rows, both `false`. The six rows from sandbox 1 are not on it.

They cannot be, and the reason is mechanical rather than a promise: the sandbox
id is a **path segment on every row**, which the `sub()` above strips for
readability. Put it back and each tape names exactly one sandbox:

```bash
jq -r '[.[].path|split("/")[2]] | unique[]' tape.json   # sandbox 1
jq -r '[.[].path|split("/")[2]] | unique[]' tape2.json  # sandbox 2
```

```text
ses_gTgfTIGgoO4dgjZU
ses_qPk73MKVXnGjJr39
```

One id each. So "no sandbox-1 row appears on sandbox-2's tape" is something you
can assert rather than eyeball — which is exactly what `verify.sh` does.

## Assertable checks

If you wanted to *verify* a run like this instead of reading it, these already
exist. **Pointers only — this showcase ships no task**, and grading appears
exactly once in this repo, in the
[support-triage capstone](../../agent-examples/support-triage/).

The interesting column is `substrate`, because it is the same distinction this
showcase is about: what happened, versus what persisted, versus what changed.

| declared check | substrate | what it would assert here |
| -------------- | --------- | ------------------------- |
| `github.tool-was-called` (`add_issue_comment`) | `tape` | the comment write **happened** — it is on the ordered tape |
| `github.issue-assignee` (`alice`) | `final` | the assign **persisted** to the end of the run |
| `github.no-new-issues` | `seed+final` | the run **changed** only what it meant to — this one reads both worlds |

Browse the full set with `npx @pome-sh/cli@latest checks github`, or
`list_checks` over MCP.

Two limits are worth stating out loud, because an id existing is not the same as
an id doing what you assume:

- **`github.tool-was-called` can only name three github actions today** —
  `create_commit_status`, `create_check_run`, `add_issue_comment`. That is why
  the `assignees` and `PATCH` rows above show `-` in the `tool` column. Widening
  the set is tracked upstream; a name may only enter it once its REST route is
  stamped, or the check would answer "never called" over a run that did it.
- **`github.no-new-issues` is repo-scoped.** It says the repository gained no
  issue. It cannot say *this issue* was left alone — there is no issue-scoped
  delta yet.

## Cost

- **0 agent evals.** An eval is charged only at finalize, and nothing here
  finalizes. Read `agent_evals.used` before and after if you want to confirm it;
  on the run above it read **178 both times**.
- **0 API keys.** Single seat.
- **2 concurrent sandboxes** while both are up.

A sandbox expires 30 minutes after creation. Stop them when you are done rather
than waiting:

```bash
npx @pome-sh/cli@latest sandbox stop "$POME_SESSION_ID" --discard
```

## Run it yourself

[`verify.sh`](./verify.sh) does everything above unattended and asserts both
halves, so the claims on this page stay checkable:

```bash
npx @pome-sh/cli@latest login    # once
./showcases/cross-call-state/verify.sh
```

It mints two sandboxes, drives the arc, asserts the accumulation, asserts the
second world is untouched, and stops both on exit — including on failure. It
exits non-zero if either half stops being true.

## Next

- The [github quickstart](https://docs.pome.sh/quickstart/twins/github) — the
  same twin, one write, in five minutes.
- [`agent-examples/support-triage`](../../agent-examples/support-triage/) — the
  one graded lesson, where a real agent is scored on a task like this.
