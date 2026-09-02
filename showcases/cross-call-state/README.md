<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cross-call state

Run the automated check from the repository root:

```bash
./showcases/cross-call-state/verify.sh
```

One local GitHub digital twin retains three writes across calls. A second process keeps untouched state, its own tape, and separate credentials. The script ends with `PASS` when every assertion holds.

See the [showcase prerequisites](../README.md) before running it.

## Optional Manual Check

Use three terminals. Ports `3333` and `3334` must be available. From an empty parent directory, prepare separate working directories:

```bash
mkdir pome-cross-call-state
cd pome-cross-call-state
mkdir twin-a twin-b
```

Start twin A in the second terminal and leave it running:

```bash
cd pome-cross-call-state/twin-a
GITHUB_CLONE_DB=.pome/github.db \
  npx -y @pome-sh/cli@latest twin start github --port 3333
```

From `pome-cross-call-state` in the first terminal, read the URL and token, then inspect the initial issue:

```bash
A=$(jq -r .rest_url twin-a/.pome/twin-status.json)
AK="Authorization: Bearer $(jq -r .auth_token twin-a/.pome/twin-status.json)"
curl -s -H "$AK" "$A/repos/acme/api/issues/1" \
  | jq -c '{state, comments, assignees: [.assignees[].login]}'
```

Checkpoint:

```json
{"state":"open","comments":0,"assignees":[]}
```

Add a comment, assign `alice`, and close the issue:

```bash
curl -s -X POST -H "$AK" -H 'Content-Type: application/json' \
  -d '{"body":"Repro: POST /orders returns 500 without currency."}' \
  -o /dev/null -w '%{http_code}\n' \
  "$A/repos/acme/api/issues/1/comments"
curl -s -X POST -H "$AK" -H 'Content-Type: application/json' \
  -d '{"assignees":["alice"]}' -o /dev/null -w '%{http_code}\n' \
  "$A/repos/acme/api/issues/1/assignees"
curl -s -X PATCH -H "$AK" -H 'Content-Type: application/json' \
  -d '{"state":"closed"}' -o /dev/null -w '%{http_code}\n' \
  "$A/repos/acme/api/issues/1"
curl -s -H "$AK" "$A/repos/acme/api/issues/1" \
  | jq -c '{state, comments, assignees: [.assignees[].login]}'
```

Checkpoint:

```text
201
201
200
{"state":"closed","comments":1,"assignees":["alice"]}
```

The tape must contain the three mutations in order and the assignment delta:

```bash
curl -s -H "$AK" "$A/_pome/events" > tape-a.json
jq -c '{
  methods: [.[] | select(.state_mutation) | .method],
  assignment: ([.[] | select(.path | endswith("/assignees"))][0].state_delta
    | {before: .before.assignees, after: .after.assignees})
}' tape-a.json
```

Checkpoint:

```json
{"methods":["POST","POST","PATCH"],"assignment":{"before":[],"after":["alice"]}}
```

Start twin B in the third terminal and leave both processes running:

```bash
cd pome-cross-call-state/twin-b
GITHUB_CLONE_DB=.pome/github.db \
  npx -y @pome-sh/cli@latest twin start github --port 3334
```

From the first terminal, compare both processes and inspect twin B's tape:

```bash
for d in twin-a twin-b; do
  U=$(jq -r .rest_url "$d/.pome/twin-status.json")
  K=$(jq -r .auth_token "$d/.pome/twin-status.json")
  curl -s -H "Authorization: Bearer $K" "$U/repos/acme/api/issues/1" \
    | jq -c --arg twin "$d" \
      '{$twin,state,comments,assignees:[.assignees[].login]}'
done

B=$(jq -r .rest_url twin-b/.pome/twin-status.json)
BK="Authorization: Bearer $(jq -r .auth_token twin-b/.pome/twin-status.json)"
curl -s -H "$BK" "$B/_pome/events" \
  | jq '[.[] | select(.state_mutation)] | length'
curl -s -o /dev/null -w '%{http_code}\n' -H "$AK" \
  "$B/repos/acme/api/issues/1"
```

Checkpoint:

```text
{"twin":"twin-a","state":"closed","comments":1,"assignees":["alice"]}
{"twin":"twin-b","state":"open","comments":0,"assignees":[]}
0
401
```

Both database files must also exist at `twin-a/.pome/github.db` and `twin-b/.pome/github.db`. Stop both twins with `Ctrl-C`, then remove `pome-cross-call-state`.
