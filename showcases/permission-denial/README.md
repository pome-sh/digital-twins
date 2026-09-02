<!-- SPDX-License-Identifier: Apache-2.0 -->

# Permission denial

This procedure demonstrates two properties of a local GitHub digital twin.

1. A refused merge appears on the tape and does not change state.
2. The same merge succeeds for an identity with push access.

## Prerequisites

- Node.js 24 or later
- npm and `npx`
- `curl`, `jq`, and `diff`
- Two terminal windows

Port `3333` must be available.

## Prepare The Seed

In the first terminal, run these commands from an empty parent directory.

```bash
mkdir pome-permission-denial
cd pome-permission-denial
mkdir -p twin/.pome-data/github

node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' \
  > twin/.pome-data/github/secret

cat > twin/seed.json <<'JSON'
{
  "repositories": [
    {
      "owner": "acme",
      "name": "api",
      "collaborators": ["alice"],
      "files": [
        {
          "path": "src/timeout.ts",
          "content": "export const ORDER_TIMEOUT_MS = 5000;\n"
        },
        {
          "path": "src/timeout.ts",
          "branch": "fix/order-timeout",
          "content": "export const ORDER_TIMEOUT_MS = 30000;\n"
        }
      ],
      "pull_requests": [
        {
          "author": "alice",
          "base": "main",
          "head": "fix/order-timeout",
          "title": "Raise the order API timeout to 30s"
        }
      ]
    }
  ]
}
JSON
```

Keep this terminal in `pome-permission-denial`.

## Start The Twin

In the second terminal, enter `pome-permission-denial/twin`.
Then start the twin.

```bash
GITHUB_CLONE_DB=.pome/github.db \
  npx -y @pome-sh/cli@latest twin start github --port 3333 --seed seed.json
```

Keep this command active.
The output must include these lines.

```text
Pome github twin listening at http://127.0.0.1:3333/s/standalone
Seed: seed.json (replaces the github twin's default).
Auth: using the persisted secret from .pome-data/github/secret (an env-injected TWIN_AUTH_SECRET overrides it).
Ctrl-C to stop.
```

The command also writes `twin/.pome/twin-status.json`.

## Prepare Two Identities

In the first terminal, read the URL.
Read the printed token from the same file.

```bash
T=$(jq -r .rest_url twin/.pome/twin-status.json)
AGENT="Authorization: Bearer $(jq -r .auth_token twin/.pome/twin-status.json)"
```

Create a token for `ci-bot` with the persisted secret.

```bash
export TWIN_AUTH_SECRET=$(cat twin/.pome-data/github/secret)
CI_BOT="Authorization: Bearer $(node -e '
const { createHmac } = require("node:crypto");
const b = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const head = b({ alg: "HS256", typ: "JWT" });
const body = b({ sid: "standalone", team_id: "tm_local", login: "ci-bot",
  exp: Math.floor(Date.now() / 1000) + 86400 });
const signature = createHmac("sha256", process.env.TWIN_AUTH_SECRET)
  .update(head + "." + body).digest("base64url");
console.log(head + "." + body + "." + signature);
')"
unset TWIN_AUTH_SECRET
```

Check both identities.

```bash
curl -s -H "$AGENT" "$T/user" | jq -r .login
curl -s -H "$CI_BOT" "$T/user" | jq -r .login
```

Checkpoint:

```text
pome-agent
ci-bot
```

The twin grants push access to `pome-agent`.
The seed does not grant push access to `ci-bot`.

## Record The Initial State

Confirm that the pull request is open.

```bash
curl -s -H "$CI_BOT" "$T/repos/acme/api/pulls/1" \
  | jq -c '{number, state, merged, merge_commit_sha}'
```

Checkpoint:

```json
{"number":1,"state":"open","merged":false,"merge_commit_sha":null}
```

Save the complete exported state.

```bash
curl -s -H "$AGENT" "$T/_pome/state" | jq -S . > world-before.json
```

## Request A Refused Merge

Send the merge request as `ci-bot`.

```bash
curl -s -X PUT -H "$CI_BOT" -H 'Content-Type: application/json' -d '{}' \
  -o denied.json -w '%{http_code}\n' \
  "$T/repos/acme/api/pulls/1/merge"

jq -c '{message, documentation_url, status}' denied.json
```

Checkpoint:

```text
403
{"message":"Must have push access to the repository to merge pull requests.","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"403"}
```

## Prove That State Did Not Change

Save the state after the refusal.
Compare it with the initial state.

```bash
curl -s -H "$AGENT" "$T/_pome/state" | jq -S . > world-after.json
diff -u world-before.json world-after.json && \
  printf 'state is unchanged\n'
```

Checkpoint:

```text
state is unchanged
```

`diff` must produce no output.

Read the pull request again.

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/pulls/1" \
  | jq -c '{state, merged, merge_commit_sha}'
```

Checkpoint:

```json
{"state":"open","merged":false,"merge_commit_sha":null}
```

## Inspect The Refusal On The Tape

Save the tape.
Then select the refused merge.

```bash
curl -s -H "$AGENT" "$T/_pome/events" > tape.json
jq -c '.[]
  | select(.status == 403 and (.path | endswith("/merge")))
  | {status, state_mutation, state_delta, error, fidelity}' tape.json
```

Checkpoint:

```json
{"status":403,"state_mutation":false,"state_delta":null,"error":"Must have push access to the repository to merge pull requests.","fidelity":"semantic"}
```

The tape records the refusal.
The event has no state change.

## Request An Allowed Merge

Send the same request as `pome-agent`.
Do not restart or change the twin.

```bash
curl -s -X PUT -H "$AGENT" -H 'Content-Type: application/json' -d '{}' \
  -o allowed.json -w '%{http_code}\n' \
  "$T/repos/acme/api/pulls/1/merge"
```

The status must be `200`.

Check the pull request.
Then check the merged file.

```bash
curl -s -H "$AGENT" "$T/repos/acme/api/pulls/1" \
  | jq -c '{state, merged}'

curl -s -H "$AGENT" "$T/repos/acme/api/contents/src/timeout.ts" \
  | jq -r '.content | @base64d'
```

Checkpoint:

```text
{"state":"closed","merged":true}
export const ORDER_TIMEOUT_MS = 30000;
```

Inspect both merge events.

```bash
curl -s -H "$AGENT" "$T/_pome/events" > tape.json
jq -r '.[] | select(.path | endswith("/merge"))
  | [.status, .state_mutation, (.state_delta | type)] | @tsv' tape.json
```

Checkpoint:

```text
403	false	null
200	true	object
```

The same endpoint produced different results for the two identities.

## Clean Up

Press `Ctrl-C` in the twin terminal.

In the first terminal, remove the procedure directory.

```bash
cd ..
rm -rf pome-permission-denial
```

## Run The Automated Check

From the repository root, run this command.

```bash
./showcases/permission-denial/verify.sh
```

The script creates its seed and signing secret in a temporary directory.
It verifies the refusal, unchanged state, tape event, and identity-based result.
It stops the twin and removes its temporary files.
