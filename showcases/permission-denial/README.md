<!-- SPDX-License-Identifier: Apache-2.0 -->

# Permission denial

**In about four minutes, on your own machine, you will watch a twin refuse a
merge — and then prove, out of the twin's own books, that the pull request did
not move.**

Anything can return a `403`. A `case` statement can return a `403`. The two
hard parts are the ones either side of it: that the refusal is a *recorded
event* you can read back afterwards, and that the world is *provably* where you
left it. That is what a twin has and a mock does not.

The property has two halves, and the second is the one that matters:

1. **A refusal is an event, and it changes nothing.** The `403` lands on the
   twin's tape carrying `state_mutation: false` and `state_delta: null`, and
   the entire exported world reads back byte-identical across it.
2. **The refusal is about who asked, not about the endpoint.** Same request,
   same twin process, one second apart, two bearers — `403` and `200`. A stub
   refuses everyone; a twin refuses *you*.

Nothing here is graded, nothing needs an API key, and nothing costs anything.
There is no account and no login on this page. See [Cost](#cost).

## Prereqs

- **Node ≥ 24**, so `npx` can fetch the CLI. That is the whole install.
- `curl`, `jq` and `diff` for the transcripts.
- Your own coding agent (Claude Code, Cursor, …) if you want it driven for you.

No Pome account. No `pome login`. No `ANTHROPIC_API_KEY`. You are the only
seat, and nothing you do below leaves your machine.

## Paste this to your agent

```text
Boot a Pome github twin locally against a seed I will give you, then show me
what it does when an identity without push access tries to merge.

Set up the directory first — the twin needs a signing secret it can reuse,
because we are going to mint a second identity against it:

  mkdir -p twin/.pome-data/github
  node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' \
    > twin/.pome-data/github/secret

Write the seed to twin/seed.json (I will paste it), then boot it as a
foreground server and leave it running:

  cd twin && GITHUB_CLONE_DB=.pome/github.db \
    npx @pome-sh/cli@latest twin start github --port 3333 --seed seed.json

It prints POME_GITHUB_REST_URL and POME_AUTH_TOKEN on stdout and writes the
same values to twin/.pome/twin-status.json — read the JSON, there is nothing
to log into. That bearer's `login` claim is pome-agent, who has push.

Then mint a SECOND bearer for the same twin, signed with the same secret but
with login "ci-bot", and show me: what ci-bot can read on pull request #1,
what happens when ci-bot tries to merge it, and whether the pull request
moved. Read GET <rest_url>/_pome/state before and after and diff the two.
Then read the tape at GET <rest_url>/_pome/events and show me the refusal
row with its status, state_mutation and state_delta.

Finally, send the SAME merge request from both bearers and show me the two
answers together.

Use curl and jq. This is ungraded — do not finalize anything, and keep your
own evaluator and observability setup. Stop the twin with Ctrl-C when I say
so.
```

Everything below is what you should see. Every output block is verbatim from a
real run on 2026-08-29, CLI `0.34.3`. Work in one empty directory; every path
below is relative to it.

## The world

This showcase does not use the twin's default seed. The default world has one
repository and one issue, and nothing in it is worth refusing — so we hand the
twin a world that has something at stake: an open pull request that changes a
file on `main`.

First, a signing secret. `twin start` looks for one at
`.pome-data/<twin>/secret` and reuses it if it finds one, otherwise it
generates a throwaway it never writes down — and we need a known key later, to
mint a second identity the twin will accept:

```bash
mkdir -p twin/.pome-data/github
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' \
  > twin/.pome-data/github/secret
```

Then the world itself:

```bash
cat > twin/seed.json <<'JSON'
{
  "repositories": [
    {
      "owner": "acme",
      "name": "api",
      "collaborators": ["alice"],
      "files": [
        { "path": "src/timeout.ts",
          "content": "export const ORDER_TIMEOUT_MS = 5000;\n" },
        { "path": "src/timeout.ts", "branch": "fix/order-timeout",
          "content": "export const ORDER_TIMEOUT_MS = 30000;\n" }
      ],
      "pull_requests": [
        { "author": "alice", "base": "main", "head": "fix/order-timeout",
          "title": "Raise the order-service timeout to 30s" }
      ]
    }
  ]
}
JSON
```

Boot it. This is a foreground server — give it its own terminal and leave it
running.

```bash
cd twin
GITHUB_CLONE_DB=.pome/github.db \
  npx @pome-sh/cli@latest twin start github --port 3333 --seed seed.json
```

```text
Pome github twin listening at http://127.0.0.1:3333/s/standalone
Seed: seed.json (replaces the github twin's default).
Auth: using the persisted secret from .pome-data/github/secret (an env-injected TWIN_AUTH_SECRET overrides it).
POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone
POME_GITHUB_MCP_URL=http://127.0.0.1:3333/s/standalone/mcp
POME_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzaWQiOiJzdGFuZGFsb25lIiwidGVhbV9pZCI6InRtX2xvY2FsIiwibG9naW4iOiJwb21lLWFnZW50IiwiZXhwIjoxNzg4MTA1MTIzfQ.NNYISO5keqSG52-5uDKgC-hvlXd6vq178n7FqQMVYWg
Health check (no auth): curl http://127.0.0.1:3333/healthz
Ctrl-C to stop.
```

Two of those lines are the mint, and neither took an account: line 3 says the
twin found the secret we wrote, and line 6 hands over a bearer good for 24
hours. Yours will differ. Leave this terminal running.

In a second terminal, back in the directory that holds `twin/`:

```bash
T=$(jq -r .rest_url twin/.pome/twin-status.json)
AGENT="Authorization: Bearer $(jq -r .auth_token twin/.pome/twin-status.json)"
```

One pull request, open:

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/pulls" \
  | jq -c '.[] | {number, title, state}'
```

```json
{"number":1,"title":"Raise the order-service timeout to 30s","state":"open"}
```

And the table that decides everything below — who may write to this repository:

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/collaborators" | jq -r '.[].login'
```

```text
alice
pome-agent
```

The seed listed only `alice`. **`pome-agent` is there because the twin puts it
on every seeded repository with `push`**, so the bearer it just printed can
actually do something — a fair exam needs an examinee who can act. That is also
why this page mints its own second identity rather than seeding one: there is
no seed that makes `pome-agent` powerless.

The bearer you are holding is `pome-agent`, and the twin will tell you so:

```bash
curl -s -H "$AGENT" "$T/user" | jq -r .login
```

```text
pome-agent
```

Take a fingerprint of the whole world before touching anything. `/_pome/state`
is the twin's own export of everything it holds:

```bash
curl -s -H "$AGENT" "$T/_pome/state" | jq -S . > world-before.json
```

## Half 1 — the refusal, and the world after it

Now a second identity. The twin authenticates a bearer and reads its `login`
claim; nothing else about the caller is consulted. So an identity is just a
JWT signed with the twin's secret — the same secret the twin told us it is
using on line 3 of its boot. Hosted, the sandbox issues its bearers for you.
Locally you are the issuer:

```bash
export TWIN_AUTH_SECRET=$(cat twin/.pome-data/github/secret)
CI_BOT="Authorization: Bearer $(node -e '
const { createHmac } = require("node:crypto");
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = b({ alg: "HS256", typ: "JWT" });
const body = b({ sid: "standalone", team_id: "tm_local", login: "ci-bot",
                 exp: Math.floor(Date.now() / 1000) + 86400 });
const sig = createHmac("sha256", process.env.TWIN_AUTH_SECRET)
  .update(head + "." + body).digest("base64url");
console.log(head + "." + body + "." + sig);
')"
```

`ci-bot` is not a hypothetical. It is the shape most agents run as: an
automation identity somebody wired up months ago and never granted write to
this repository. The twin accepts the bearer — it is validly signed — and knows
exactly who it is:

```bash
curl -s -H "$CI_BOT" "$T/user" | jq -r .login
```

```text
ci-bot
```

**It is refused, not blindfolded.** `ci-bot` can read the pull request in full,
which is the distinction a mock that 404s everything cannot draw:

```bash
curl -s -H "$CI_BOT" "$T/repos/acme/api/pulls/1" \
  | jq -c '{number, title, state, merged}'
```

```json
{"number":1,"title":"Raise the order-service timeout to 30s","state":"open","merged":false}
```

Now merge it.

```bash
curl -s -X PUT -H "$CI_BOT" -H 'Content-Type: application/json' -d '{}' \
  -o denied.json -w 'HTTP %{http_code}\n' \
  "$T/repos/acme/api/pulls/1/merge"
```

```text
HTTP 403
```

```bash
jq . denied.json
```

```json
{
  "message": "Must have push access to the repository to merge pull requests.",
  "documentation_url": "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request",
  "status": "403"
}
```

That is GitHub's error *shape*, not a twin's invention — the three fields a
GitHub REST error carries, including the `status` leaf it repeats inside the
body as a string, and a `documentation_url` pointing at **this operation**
rather than at the top of the REST docs. An agent that parses GitHub errors
parses this one without a special case. Whether the wording matches GitHub's
own is a claim the twin makes explicitly rather than implies, and it makes it
on the tape — one column, two sections down.

Now the half of the claim that is easy to assert and hard to show. The pull
request:

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/pulls/1" \
  | jq -c '{state, merged, merge_commit_sha}'
```

```json
{"state":"open","merged":false,"merge_commit_sha":null}
```

And then the stronger version — not "the field I thought to check is
unchanged", but *the entire world*:

```bash
curl -s -H "$AGENT" "$T/_pome/state" | jq -S . > world-after.json
diff world-before.json world-after.json && echo "the world is byte-identical"
```

```text
the world is byte-identical
```

`diff` printed nothing, so the `echo` ran. Every repository, branch, file blob,
pull request, comment and label the twin holds is exactly what it was before
the refusal. Not "no merge commit" — *nothing at all*.

## Read the tape

The refusal is also on the record. The tape is the twin's own ordered log of
the run, served by the twin, and it needs no account either:

```bash
curl -s -H "$AGENT" "$T/_pome/events" > tape.json
jq -r '.[]|[.method,.path,.status,.state_mutation,.fidelity]|@tsv' \
  tape.json | column -t
```

```text
GET  /s/standalone/repos/acme/api/pulls          200  false  semantic
GET  /s/standalone/repos/acme/api/collaborators  200  false  semantic
GET  /s/standalone/user                          200  false  semantic
GET  /s/standalone/user                          200  false  semantic
GET  /s/standalone/repos/acme/api/pulls/1        200  false  semantic
PUT  /s/standalone/repos/acme/api/pulls/1/merge  403  false  semantic
GET  /s/standalone/repos/acme/api/pulls/1        200  false  semantic
```

**You should see:**

- **The refused merge is a row.** It is not an exception that vanished into a
  log line; it is the sixth of the seven events above, in the order you made
  them.
- **`state_mutation` is `false` on it**, and on every other row here. This is a
  recorded boolean, not a guess from the HTTP method — the same column reads
  `true` in the next section, on a `PUT` to the same path.
- **`fidelity` is `semantic`.** The twin is telling you it *modelled* this
  refusal against captured GitHub behaviour. Hold on to that column — it is
  what separates the two remaining answers in
  [Three ways to be told no](#three-ways-to-be-told-no).

The row carries the refusal itself, not just its code:

```bash
jq '.[] | select(.status == 403)
     | {status, state_mutation, state_delta, error}' tape.json
```

```json
{
  "status": 403,
  "state_mutation": false,
  "state_delta": null,
  "error": "Must have push access to the repository to merge pull requests."
}
```

`state_delta` is the field that makes this more than a status code. Every write
the twin performs stamps its own `{before, after}` there. A refusal stamps
`null` — not an empty delta, *no delta* — because nothing was attempted against
the store at all. The gate runs before the domain call.

## Half 2 — the refusal is about who asked

A stub that refuses everyone would produce every block above. So the claim only
means something if the *same request* gets a different answer from a different
caller — and the weak way to show that is to reconfigure something and try
again, which is indistinguishable from flipping a switch.

So do not reconfigure anything. The twin has been running this whole time, its
seed untouched, no toggle between these two lines. The only thing that differs
is which bearer goes on the wire:

```bash
for id in "ci-bot|$CI_BOT" "pome-agent|$AGENT"; do
  curl -s -o /dev/null -w "${id%%|*} %{http_code}\n" -X PUT -H "${id#*|}" \
    -H 'Content-Type: application/json' -d '{}' \
    "$T/repos/acme/api/pulls/1/merge"
done
```

```text
ci-bot 403
pome-agent 200
```

One request, two answers, a second apart, nothing restarted. And this time the
world moved:

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/pulls/1" | jq -c '{state, merged}'
```

```json
{"state":"closed","merged":true}
```

```bash
curl -s -H "$AGENT" "$T/_pome/state" | jq -S . > world-merged.json
diff world-after.json world-merged.json \
  | grep -E '"(content|merged|merge_commit_sha|state)"'
```

```text
<           "content": "export const ORDER_TIMEOUT_MS = 5000;\n",
>           "content": "export const ORDER_TIMEOUT_MS = 30000;\n",
<           "merge_commit_sha": null,
<           "merged": 0,
>           "merge_commit_sha": "5fc8143d7b8d6b858d52287c393b7c4255ce9346",
>           "merged": 1,
<           "state": "open",
>           "state": "closed",
```

The merge that `ci-bot` was refused is the merge `pome-agent` performed, and it
did the work: `main`'s copy of `src/timeout.ts` now carries the branch's value.
The twin did not replay a fixture — it committed, and the sha above is that
commit. It is the one line on this page that is not reproducible: yours will
be a different sha, because it is a different commit.

Both attempts are on the tape, and the `state_mutation` column separates them
without you having to read the status:

```bash
curl -s -H "$AGENT" "$T/_pome/events" > tape.json
jq -r '.[] | select(.path | endswith("/merge"))
     | [.status, .state_mutation, (.state_delta | type)] | @tsv' \
  tape.json | column -t
```

```text
403  false  null
403  false  null
200  true   object
```

Two refusals with no delta, one merge with one. That is the whole property in
three lines.

**One limit, stated out loud, because it will bite an author.** The tape does
not record *who* was refused:

```bash
jq -r '[.[].request_headers.authorization] | unique[]' tape.json
```

```text
[REDACTED]
```

The bearer is redacted on every row, and no row carries a login field. So the
tape can tell you that a merge was attempted and refused; it cannot tell you
which identity earned the refusal. If that distinction matters to your grading,
it has to come from state — which, for this run, it does: the pull request is
merged, so exactly one of the two callers got through.

## Three ways to be told no

The refusal above is one of three answers this twin gives to a request it will
not fulfil, and telling them apart is most of what an agent needs from an
error. Two more, on the same twin:

```bash
curl -s -X PUT -H "$AGENT" -H 'Content-Type: application/json' -d '{}' \
  "$T/repos/acme/api/pulls/99/merge" | jq .
```

```json
{
  "message": "Pull request not found",
  "documentation_url": "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request",
  "status": "404"
}
```

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/actions/runs" | jq .
```

```json
{
  "message": "This endpoint is not supported by this GitHub twin.",
  "_twin": {
    "fidelity": "unsupported",
    "supported_surfaces": [
      "GitHub-shaped REST",
      "POST /s/:sid/mcp",
      "GET /s/:sid/mcp/tools",
      "POST /s/:sid/mcp/tools/:name",
      "POST /s/:sid/mcp/call"
    ]
  }
}
```

The third one is the interesting one, and it is the answer a fixture server
cannot give. `GET /repos/:o/:r/actions/runs` is a real GitHub endpoint that
this twin does not model. It could have answered `404` and been indistinguishable
from a repository with no workflow runs — an agent would have believed the
empty answer and moved on. Instead it answers `501`, says so under `_twin`, and
lists what it *does* serve. **"I have not implemented this" and "this does not
exist" are different facts, and only one of them is your bug.**

The tape keeps them apart in a column, so you never have to parse a body to
find out:

```bash
curl -s -H "$AGENT" "$T/_pome/events" > tape.json
jq -r '.[]|[.status,.fidelity]|@tsv' tape.json | sort -u \
  | column -t
```

```text
200  semantic
403  semantic
404  semantic
501  unsupported
```

Three modelled answers and one honest gap. A run with no `unsupported` row is a
run that stayed inside the part of GitHub this twin actually implements — which
is a check you can declare, and the next section names it.

(There is a fourth refusal, `401`, and it answers a different question: not
*may you*, but *who are you*. The
[cross-call-state showcase](../cross-call-state/) shows one, where a twin
refuses another twin's bearer.)

### One thing on `/healthz` that is not this

The twin's liveness probe advertises a policy catalog, and it is easy to read
it as the thing you just watched:

```bash
curl -s http://127.0.0.1:3333/healthz | jq -c .access_control
```

```json
{"total":57,"allowed":42,"denied":15}
```

Those 15 are **not denied on this path**, and the fastest way to believe it is
to pick one. `add_collaborator` is in the denied-by-default column:

```bash
curl -s -H "$AGENT" "$T/_pome/access-control" \
  | jq -c '.endpoints[] | select(.tool == "add_collaborator")'
```

```json
{"tool":"add_collaborator","operation":"addCollaborator","method":"PUT","category":"collaborators","default_allowed":false,"v2":true}
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H "$AGENT" \
  -H 'Content-Type: application/json' -d '{"permission":"push"}' \
  "$T/repos/acme/api/collaborators/dana"
```

```text
201
```

That catalog is the surface a builder toggles per sandbox in the hosted
dashboard, published on the twin so the dashboard and the twin cannot disagree
about what is toggleable. A local twin has no dashboard: it serves the world as
seeded and enforces the permission model that world describes — which is what
every command above exercised, and it is GitHub's own model, a collaborator
table and a gate that reads it.

## Assertable checks

If you wanted to *verify* a run like this instead of reading it, these already
exist. **Pointers only — this showcase ships no task**, and grading appears
exactly once in this repo, in the
[support-triage capstone](../../agent-examples/support-triage/).

The interesting column is `substrate`, because a denial makes three separate
claims and each one is answered by a different body of evidence: what the world
looks like at the end, what changed to get there, and what was said on the way.

| declared check | substrate | what it would assert here | limit on the id |
| -------------- | --------- | ------------------------- | --------------- |
| `github.pr-state` (`not merged`) | `final` | the merge that was refused **did not happen** | none found. It reads the `merged` flag, and SKIPS rather than fails if an export carries no such flag — absent is not the same as false |
| `github.no-new-issues` | `seed+final` | the run **changed nothing else** in the repository | it is repo-scoped. Every github delta check is: none of them can say *this pull request* was left alone, which is why the row above carries the weight |
| `github.no-unsupported-endpoint` | `tape` | every refusal on this run was a **modelled** one | it passes a `403` and a `404` — it separates "not implemented" from everything else, and nothing more. Its own description still calls a sandbox a "session"; the wording fix is tracked upstream |

Browse the full set with `npx @pome-sh/cli@latest checks github`, or
`list_checks` over MCP.

**One candidate was rejected, and the rejection is the mechanism working.**
The obvious pick for a page about an attempted action is
`` `merge_pull_request` was never called `` — substrate `tape`, and it reads
attempts rather than outcomes, which is exactly the shape of a denial. It does
not bind. The recorder stamps an action name on only three of this twin's ~40
operations (`create_commit_status`, `create_check_run`, `add_issue_comment`),
and `merge_pull_request` is not one of them — which is why every `/merge` row
on the tape above carries `tool: null`:

```bash
jq -r '[.[] | select(.path | endswith("/merge")) | .tool // "null"]
     | unique[]' tape.json
```

```text
null
```

So the vocabulary refuses the name rather than accepting a sentence it cannot
honour: `pome checks add … --arg tool=merge_pull_request` is an error, not a
check that quietly answers "never called" over a run that did it. Widening the
set is tracked upstream, and a name may only enter it once its REST route is
stamped on both doors. **Run this search before you name a check id** — an id
reading clean in `checks` is not evidence it can say what you want about your
run.

## Cost

**Zero.** Not "free tier" — there is no meter attached to this page at all.

- **No account and no login.** Nothing here talks to pome.sh except `npx`
  fetching the CLI from the npm registry.
- **No API key.** Single seat: you, or your own coding agent.
- **No sandbox minutes and no agent evals.** Those are billed against a hosted
  sandbox at finalize; this path has neither a hosted sandbox nor a finalize.
- **One `node` process and one SQLite file**, which is the entire footprint.

Nothing expires. A local twin runs until you stop it — Ctrl-C in its terminal —
and the world is one directory:

```bash
rm -rf twin world-*.json tape.json denied.json
```

## Run it yourself

[`verify.sh`](./verify.sh) does everything above unattended and asserts both
halves, so the claims on this page stay checkable. From a clone of this repo:

```bash
./showcases/permission-denial/verify.sh
```

It is self-contained: it writes its own seed and its own signing secret into a
throwaway directory, boots the twin on a free port, and mints both identities
itself — there is no login step to do first. It asserts the refusal, asserts
the world is byte-identical across it, asserts the same request is allowed for
the other bearer while the twin keeps running, and stops the process on exit,
including on failure. It exits non-zero if any of that stops being true.

## Next

- The [github quickstart](https://docs.pome.sh/quickstart/twins/github) — the
  same twin, one write, in five minutes, on the hosted path.
- [`cross-call-state`](../cross-call-state/) — the sibling showcase: what the
  twin does when the write *is* allowed, and how long it remembers.
- [`agent-examples/support-triage`](../../agent-examples/support-triage/) — the
  one graded lesson, where a real agent is scored on a task like this.
