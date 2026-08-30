<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cross-call state

**In about three minutes, on your own machine, you will watch a twin keep
books.** Three writes, each read back through the twin's own surfaces, all
three still there on a single later read — and then the same read against a
second twin process running at the same moment, where none of them exist.

A mock answers from a script. A twin holds state. Those are different claims,
and this is the one that is measurable.

The property has two halves, and the second is the one that matters:

1. **State survives across calls inside one twin process.** Call N's write is
   readable at call N+1.
2. **State does not survive into a second process.** A second `twin start` on
   its own port with its own SQLite file is a different world, and it stays a
   different world while the first one is still running.

Nothing here is graded, nothing needs an API key, and nothing costs anything.
There is no account and no login on this page. See [Cost](#cost).

## Prereqs

- **Node ≥ 24**, so `npx` can fetch the CLI. That is the whole install.
- `curl` and `jq` for the transcripts.
- Your own coding agent (Claude Code, Cursor, …) if you want it driven for you.

No Pome account. No `pome login`. No `ANTHROPIC_API_KEY`. You are the only
seat, and nothing you do below leaves your machine.

## Paste this to your agent

```text
Boot two Pome github twins locally, each in its own directory so each gets
its own SQLite store. They are foreground servers, so give each its own
terminal or background it, and leave both running:

  mkdir -p twin-a twin-b
  (cd twin-a && GITHUB_CLONE_DB=.pome/github.db \
     npx @pome-sh/cli@latest twin start github --port 3333)
  (cd twin-b && GITHUB_CLONE_DB=.pome/github.db \
     npx @pome-sh/cli@latest twin start github --port 3334)

Each one prints POME_GITHUB_REST_URL and POME_AUTH_TOKEN on stdout and
writes the same values to <dir>/.pome/twin-status.json — read the JSON,
there is nothing to log into.

In twin A: read issue #1 of acme/api, then make three writes — post a
comment, assign alice, close the issue — reading each one back through a
different surface from the one that wrote it. Then read the tape at
GET <rest_url>/_pome/events and show me the rows in order with their
status, state_mutation and tool.

Then, with twin A still running and still holding those three writes, send
the same issue read to twin B and show me the two answers together. Show me
twin B's tape too.

Use curl and jq. Each twin has its own bearer: a 401 means you used the
other twin's. This is ungraded — do not finalize anything, and keep your
own evaluator and observability setup. Stop both twins with Ctrl-C when I
say so.
```

Everything below is what you should see. Every output block is verbatim from a
real run on 2026-08-29, CLI `0.34.2`; a 2026-08-30 re-run on CLI `0.42.1`
reproduced every block. Work in one empty directory; paths are relative to it.

## The world

Boot the first twin. Give it its own directory, and point its store at a file
inside that directory — the twin defaults to an in-memory database, and a file
makes "two worlds" something you can list rather than take on trust.

```bash
mkdir -p twin-a && cd twin-a
GITHUB_CLONE_DB=.pome/github.db \
  npx @pome-sh/cli@latest twin start github --port 3333
```

```text
Pome github twin listening at http://127.0.0.1:3333/s/standalone
Seed: the github twin's default (pass --seed <path>, or write one with `pome twin new-seed github`).
POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone
POME_GITHUB_MCP_URL=http://127.0.0.1:3333/s/standalone/mcp
POME_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzaWQiOiJzdGFuZGFsb25lIiwidGVhbV9pZCI6InRtX2xvY2FsIiwibG9naW4iOiJwb21lLWFnZW50IiwiZXhwIjoxNzg4MDk5NzA5fQ._R5jttuezYifeRdilZh7q2_K-1jVgGW-CcAn_FvVoOc
Health check (no auth): curl http://127.0.0.1:3333/healthz
Ctrl-C to stop.
```

That is the mint, and it took no account: the bearer is on stdout and in
`twin-a/.pome/twin-status.json`. Yours will differ — the secret is generated
per boot and the token is good for 24 hours. Leave this terminal running.

In a second terminal, back in the directory that holds `twin-a/`:

```bash
A=$(jq -r .rest_url twin-a/.pome/twin-status.json)
AK="Authorization: Bearer $(jq -r .auth_token twin-a/.pome/twin-status.json)"
```

We passed no `--seed`, so the twin booted its own `defaultSeedState()`. For the
github twin that is one repo `acme/api` holding one open issue, `#1`, labeled
`bug`, unassigned, with no comments.

```bash
curl -s -H "$AK" "$A/repos/acme/api/issues/1" \
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

**You should see** three zeros to move: `state` is `open`, `comments` is `0`,
`assignees` is empty.

## Half 1 — state survives across calls

Three writes, on three different surfaces of the same issue.

```bash
curl -s -X POST -H "$AK" -H 'Content-Type: application/json' \
  -d '{"body":"Repro: POST /orders 500s when the payload omits `currency`."}' \
  -w '%{http_code}\n' -o /dev/null \
  "$A/repos/acme/api/issues/1/comments"
```

```text
201
```

Read it back through the twin's own comment surface — a different endpoint from
the one that wrote it, one call later:

```bash
curl -s -H "$AK" "$A/repos/acme/api/issues/1/comments" \
  | jq -r '.[] | "\(.user.login): \(.body)"'
```

```text
pome-agent: Repro: POST /orders 500s when the payload omits `currency`.
```

Two more writes, and no read between them:

```bash
curl -s -X POST -H "$AK" -H 'Content-Type: application/json' \
  -d '{"assignees":["alice"]}' -w '%{http_code}\n' -o /dev/null \
  "$A/repos/acme/api/issues/1/assignees"

curl -s -X PATCH -H "$AK" -H 'Content-Type: application/json' \
  -d '{"state":"closed"}' -w '%{http_code}\n' -o /dev/null \
  "$A/repos/acme/api/issues/1"
```

```text
201
200
```

Now the point of the whole exercise. **One** read, and all three writes are
there at once — a comment posted four calls ago, an assignee from two calls
ago, a state change from one:

```bash
curl -s -H "$AK" "$A/repos/acme/api/issues/1" \
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

The tape is the twin's own record of the run, served by the twin itself. It
needs no account either:

```bash
curl -s -H "$AK" "$A/_pome/events" > tape-a.json
jq -r '.[]|[.method,.path,.status,.state_mutation,.tool//"-"]|@tsv' \
  tape-a.json | column -t
```

```text
GET    /s/standalone/repos/acme/api/issues/1            200  false  -
POST   /s/standalone/repos/acme/api/issues/1/comments   201  true   add_issue_comment
GET    /s/standalone/repos/acme/api/issues/1/comments   200  false  -
POST   /s/standalone/repos/acme/api/issues/1/assignees  201  true   -
PATCH  /s/standalone/repos/acme/api/issues/1            200  true   -
GET    /s/standalone/repos/acme/api/issues/1            200  false  -
```

**You should see:**

- **Six rows, in the order you made them.** The tape is ordered, not a set.
- **`state_mutation` true on exactly three of them** — the three writes, and
  none of the reads. This is a recorded boolean, not a guess from the HTTP
  method.
- **`add_issue_comment` stamped in the `tool` column** on the comment write.
  The other two writes read `-`: only three github action names are stamped
  today (see [Assertable checks](#assertable-checks)).
- **`/s/standalone` on the front of every path.** A standalone twin serves one
  fixed session id. Hold on to that — it is the thing that is *not* the
  boundary in Half 2.

Every row also carries how it was judged:

```bash
jq -r '[.[].fidelity] | unique[]' tape-a.json
```

```text
semantic
```

One value across all six: a behavioural contract compared against a captured
GitHub response, not a shape check.

And the field that is the actual receipt for "the twin keeps books" — each
write row carries the before/after it caused. `.[3]` is the assign: the fourth
row in the table above, counting from zero.

```bash
jq -c '.[3].state_delta | {b: .before.assignees, a: .after.assignees}' \
  tape-a.json
```

```json
{"b":[],"a":["alice"]}
```

Reads carry `state_delta: null`. Only the three writes carry a delta.

## Half 2 — and it does not cross processes

Leave twin A running. In a third terminal, boot a second twin: its own
directory, its own store, its own port.

```bash
mkdir -p twin-b && cd twin-b
GITHUB_CLONE_DB=.pome/github.db \
  npx @pome-sh/cli@latest twin start github --port 3334
```

It prints the same seven lines, with 3334 in place of 3333 and a token of its
own. Back in the work terminal:

```bash
B=$(jq -r .rest_url twin-b/.pome/twin-status.json)
BK="Authorization: Bearer $(jq -r .auth_token twin-b/.pome/twin-status.json)"
echo "$B"
```

```text
http://127.0.0.1:3334/s/standalone
```

Read the same issue, with the second twin's own bearer:

```bash
curl -s -H "$BK" "$B/repos/acme/api/issues/1" \
  | jq '{state, comments, assignees: [.assignees[].login]}'
```

```json
{
  "state": "open",
  "comments": 0,
  "assignees": []
}
```

```bash
curl -s -H "$BK" "$B/repos/acme/api/issues/1/comments" | jq -c
```

```text
[]
```

Back to three zeros. The issue is the same issue — same number, same title,
same `bug` label — and the comment, the assignee and the close are simply not
there.

**The weak version of this claim is sequential**, and sequential is
indistinguishable from a reset: boot a twin, see an empty world, shrug. So do
not do it sequentially. Both twins are running right now. Ask each of them the
same question:

```bash
for d in twin-a twin-b; do
  U=$(jq -r .rest_url "$d/.pome/twin-status.json")
  K=$(jq -r .auth_token "$d/.pome/twin-status.json")
  curl -s -H "Authorization: Bearer $K" "$U/repos/acme/api/issues/1" |
    jq -c --arg twin "$d" '{$twin,state,comments,assignees:[.assignees[].login]}'
done
```

```text
{"twin":"twin-a","state":"closed","comments":1,"assignees":["alice"]}
{"twin":"twin-b","state":"open","comments":0,"assignees":[]}
```

One request, two answers, neither twin restarted. Twin A did not rewind to let
twin B be empty; it is still holding all three writes while twin B has never
seen one of them. That is isolation, and a sequential read cannot say it.

The tape is per-process too. Same command as before, pointed at twin B:

```bash
curl -s -H "$BK" "$B/_pome/events" > tape-b.json
jq -r '.[]|[.method,.path,.status,.state_mutation,.tool//"-"]|@tsv' \
  tape-b.json | column -t
```

```text
GET  /s/standalone/repos/acme/api/issues/1           200  false  -
GET  /s/standalone/repos/acme/api/issues/1/comments  200  false  -
GET  /s/standalone/repos/acme/api/issues/1           200  false  -
```

Three rows, all `false` — the three reads you just made against twin B, and
none of twin A's six.

Now the part that is easy to get wrong. On the hosted path the session id is
the boundary and it is a path segment on every row, so the tape names its own
world. **Locally it does not**, because a standalone twin serves one fixed
session id and both of these twins are serving it:

```bash
jq -r '[.[].path|split("/")[2]] | unique[]' tape-a.json tape-b.json
```

```text
standalone
standalone
```

Two tapes, one id. The boundary here is the operating-system process, and the
field on every row that names it is the `Host` header the request arrived on:

```bash
jq -r '[.[].request_headers.host] | unique[]' tape-a.json tape-b.json
```

```text
127.0.0.1:3333
127.0.0.1:3334
```

One authority each. So "no twin-A row appears on twin-B's tape" is something
you can assert rather than eyeball — which is exactly what `verify.sh` does,
and it does it as an invariant (*no row on B's tape carries any authority but
B's*) rather than as a row count, because a row count breaks the moment a
script makes one more read than a walkthrough does.

Underneath, two directories, two stores:

```bash
ls -1 twin-a/.pome twin-b/.pome
```

```text
twin-a/.pome:
github.db
github.db-shm
github.db-wal
twin-status.json

twin-b/.pome:
github.db
github.db-shm
github.db-wal
twin-status.json
```

And the two bearers are not interchangeable. Neither process found a
`TWIN_AUTH_SECRET` in the environment or a persisted secret in its directory,
so each generated its own signing key at boot — twin A's token is not a
credential for twin B. (Export the same `TWIN_AUTH_SECRET` into both and they
would share one; that is the documented way to make them interchangeable on
purpose.)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "$AK" \
  "$B/repos/acme/api/issues/1"
```

```text
401
```

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

Browse the full set with `npx @pome-sh/cli@latest checks github` (hosted:
`list_checks` on the control MCP; the local twin's tool table lacks it).

Two limits are worth stating out loud, because an id existing is not the same
as an id doing what you assume:

- **`github.tool-was-called` can only name three github actions today** —
  `create_commit_status`, `create_check_run`, `add_issue_comment`. That is why
  the `assignees` and `PATCH` rows above show `-` in the `tool` column. Widening
  the set is tracked upstream; a name may only enter it once its REST route is
  stamped, or the check would answer "never called" over a run that did it.
- **`github.no-new-issues` is repo-scoped.** It says the repository gained no
  issue. It cannot say *this issue* was left alone — there is no issue-scoped
  delta yet.

## Cost

**Zero.** Not "free tier" — there is no meter attached to this page at all.

- **No account and no login.** Nothing here talks to pome.sh except `npx`
  fetching the CLI from the npm registry.
- **No API key.** Single seat: you, or your own coding agent.
- **No sandbox minutes and no agent evals.** Those are billed against a hosted
  sandbox at finalize; this path has neither a hosted sandbox nor a finalize.
- **Two `node` processes and two SQLite files**, which is the entire footprint.

Nothing expires. A local twin runs until you stop it — Ctrl-C in each of its
terminals — and the worlds are two directories:

```bash
rm -rf twin-a twin-b
```

## Run it yourself

[`verify.sh`](./verify.sh) does everything above unattended and asserts both
halves, so the claims on this page stay checkable. From a clone of this repo:

```bash
./showcases/cross-call-state/verify.sh
```

It is self-contained: it boots both twins itself on two free ports, in a
throwaway directory, with no login step to do first. It drives the arc, asserts
the accumulation, asserts the second world is untouched *while the first is
still holding its writes*, and stops both processes on exit — including on
failure. It exits non-zero if either half stops being true.

## Next

- [Get started](https://docs.pome.sh/quickstart/twins) — all five twins, each
  started on your own machine and driven by your own coding agent.
- [`agent-examples/support-triage`](../../agent-examples/support-triage/) — the
  one graded lesson, where a real agent is scored on a task like this.
