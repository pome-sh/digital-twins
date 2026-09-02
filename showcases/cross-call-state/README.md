<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cross-call state

This procedure demonstrates two properties of a local GitHub digital twin.

1. One twin process retains state across calls.
2. A second twin process has separate state and a separate tape.

## Prerequisites

- Node.js 24 or later
- npm and `npx`
- `curl` and `jq`
- Three terminal windows

Ports `3333` and `3334` must be available.

## Prepare The Directories

In the first terminal, run these commands from an empty parent directory.

```bash
mkdir pome-cross-call-state
cd pome-cross-call-state
mkdir twin-a twin-b
```

Keep this terminal in `pome-cross-call-state`.

## Start Twin A

In the second terminal, enter `pome-cross-call-state`.
Then start twin A.

```bash
cd twin-a
GITHUB_CLONE_DB=.pome/github.db \
  npx -y @pome-sh/cli@latest twin start github --port 3333
```

Keep this command active.
The output must include these lines.

```text
Pome github twin listening at http://127.0.0.1:3333/s/standalone
POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone
Ctrl-C to stop.
```

The command also writes `twin-a/.pome/twin-status.json`.

## Check The Initial State

In the first terminal, read the URL from the status file.
Read the token from the same file.

```bash
A=$(jq -r .rest_url twin-a/.pome/twin-status.json)
AK="Authorization: Bearer $(jq -r .auth_token twin-a/.pome/twin-status.json)"

curl -s -H "$AK" "$A/repos/acme/api/issues/1" \
  | jq '{state, comments, assignees: [.assignees[].login]}'
```

Checkpoint:

```json
{
  "state": "open",
  "comments": 0,
  "assignees": []
}
```

## Change Twin A

Add one comment.

```bash
curl -s -X POST -H "$AK" -H 'Content-Type: application/json' \
  -d '{"body":"Repro: POST /orders returns 500 without currency."}' \
  -o /dev/null -w '%{http_code}\n' \
  "$A/repos/acme/api/issues/1/comments"
```

The status must be `201`.

Read the comment through the comments endpoint.

```bash
curl -s -H "$AK" "$A/repos/acme/api/issues/1/comments" \
  | jq -r '.[] | "\(.user.login): \(.body)"'
```

Checkpoint:

```text
pome-agent: Repro: POST /orders returns 500 without currency.
```

Assign `alice`.
Then close the issue.

```bash
curl -s -X POST -H "$AK" -H 'Content-Type: application/json' \
  -d '{"assignees":["alice"]}' -o /dev/null -w '%{http_code}\n' \
  "$A/repos/acme/api/issues/1/assignees"

curl -s -X PATCH -H "$AK" -H 'Content-Type: application/json' \
  -d '{"state":"closed"}' -o /dev/null -w '%{http_code}\n' \
  "$A/repos/acme/api/issues/1"
```

The statuses must be `201` and `200`.

Read the issue again.

```bash
curl -s -H "$AK" "$A/repos/acme/api/issues/1" \
  | jq '{state, comments, assignees: [.assignees[].login]}'
```

Checkpoint:

```json
{
  "state": "closed",
  "comments": 1,
  "assignees": [
    "alice"
  ]
}
```

This response proves that one process retained all three writes.

## Inspect Tape A

Save the tape.
Then inspect its ordered events.

```bash
curl -s -H "$AK" "$A/_pome/events" > tape-a.json
jq -r '.[] | [.method, .status, .state_mutation, (.tool // "-")] | @tsv' \
  tape-a.json
```

Checkpoint:

```text
GET	200	false	-
POST	201	true	add_issue_comment
GET	200	false	-
POST	201	true	-
PATCH	200	true	-
GET	200	false	-
```

Inspect the state change for the assignment.

```bash
jq -c '.[] | select(.path | endswith("/assignees"))
  | .state_delta | {before: .before.assignees, after: .after.assignees}' \
  tape-a.json
```

Checkpoint:

```json
{"before":[],"after":["alice"]}
```

## Start Twin B

In the third terminal, enter `pome-cross-call-state`.
Then start twin B.

```bash
cd twin-b
GITHUB_CLONE_DB=.pome/github.db \
  npx -y @pome-sh/cli@latest twin start github --port 3334
```

Keep this command active.
Wait for this line.

```text
Pome github twin listening at http://127.0.0.1:3334/s/standalone
```

## Prove Process Isolation

In the first terminal, read twin B's URL.
Read twin B's token from the same file.

```bash
B=$(jq -r .rest_url twin-b/.pome/twin-status.json)
BK="Authorization: Bearer $(jq -r .auth_token twin-b/.pome/twin-status.json)"
```

Read the same issue from both running processes.

```bash
for d in twin-a twin-b; do
  U=$(jq -r .rest_url "$d/.pome/twin-status.json")
  K=$(jq -r .auth_token "$d/.pome/twin-status.json")
  curl -s -H "Authorization: Bearer $K" "$U/repos/acme/api/issues/1" \
    | jq -c --arg twin "$d" \
      '{$twin,state,comments,assignees:[.assignees[].login]}'
done
```

Checkpoint:

```json
{"twin":"twin-a","state":"closed","comments":1,"assignees":["alice"]}
{"twin":"twin-b","state":"open","comments":0,"assignees":[]}
```

Both processes remain active during this check.
Twin B did not receive twin A's writes.

Confirm that each process uses a different database file.

```bash
test -f twin-a/.pome/github.db && \
  test -f twin-b/.pome/github.db && \
  printf 'two database files exist\n'
```

Checkpoint:

```text
two database files exist
```

Save twin B's tape.
Then check its mutations.
Check its request authority.

```bash
curl -s -H "$BK" "$B/_pome/events" > tape-b.json
jq '[.[] | select(.state_mutation)] | length' tape-b.json
jq -r '[.[].request_headers.host] | unique[]' tape-b.json
```

Checkpoint:

```text
0
127.0.0.1:3334
```

Twin B's tape contains no state mutation from twin A.

Use twin A's token with twin B.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "$AK" \
  "$B/repos/acme/api/issues/1"
```

The status must be `401`.

## Clean Up

Press `Ctrl-C` in the twin A terminal.
Press `Ctrl-C` in the twin B terminal.

In the first terminal, remove the procedure directory.

```bash
cd ..
rm -rf pome-cross-call-state
```

## Run The Automated Check

From the repository root, run this command.

```bash
./showcases/cross-call-state/verify.sh
```

The script starts two twins on available ports.
It verifies retained state, process isolation, separate tapes, and separate credentials.
It stops both processes and removes its temporary files.
