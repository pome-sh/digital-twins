#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Asserts both halves of the permission-denial property against ONE local twin
# process, so this showcase's README stays checkable rather than asserted.
#
# Half 1: a refusal is a recorded event that changes nothing — the 403 is a row
#         on the tape carrying `state_mutation: false` and `state_delta: null`,
#         and the twin's whole exported world is byte-identical across it.
# Half 2: the refusal is about WHO ASKED, not about the endpoint — the same
#         request from a second bearer, against the same running twin with
#         nothing reconfigured between the two calls, is allowed.
#
# Self-contained on purpose. `twin start` reads its signing secret from
# `.pome-data/<twin>/secret` and prints its bearer to stdout, so both the mint
# and the second identity are non-interactive: this script writes the world it
# needs, boots the twin, and mints BOTH bearers rather than assuming a human
# already did the interesting part. No account, no login, no API key, no
# meter — nothing here finalizes, and there is no hosted sandbox to finalize
# against.
#
# Needs: bash, node >= 24 (for npx), curl, jq. Set POME_CLI to point at a local
# build instead of the published CLI.
#
# Two rules this file exists to keep honest, both inherited from the sibling
# showcase's debugging:
#   * The twin's credentials are read out of JSON with `jq`, never out of an
#     `export K="v"` file with `sed` — un-stripped quotes turn every curl into
#     exit 000 and a full red run that blames the wrong thing.
#   * Every tape assertion below is an INVARIANT, never a row count from a
#     hand-run. "No row that answered 4xx or 5xx mutated state" survives this
#     script making one more call than the walkthrough does; "the tape has 7
#     rows" does not.

set -euo pipefail

CLI="${POME_CLI:-npx -y @pome-sh/cli@latest}"
REPO="acme/api"
FAILS=0
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
  local code=$?
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  # Give the twin its graceful shutdown (it flushes the recorder and releases
  # the SQLite handle) before the directory holding its database disappears.
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    for _ in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1 on PATH"; exit 2; }; }
need curl
need jq
need node

# An injected TWIN_AUTH_SECRET WINS over the persisted file, which would leave
# this script minting `ci-bot` against a key the twin is not using — every call
# a 401, and the denial assertions failing for the wrong reason. The script
# owns its own environment, so it opts out and uses the persisted path the
# README teaches.
unset TWIN_AUTH_SECRET

# ok <label> <actual> <expected>
ok() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %-46s %s\n' "$1" "$2"
  else
    printf '  FAIL %-46s got %s, want %s\n' "$1" "$2" "$3"
    FAILS=$((FAILS + 1))
  fi
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pick_port() { # pick_port <from> -> first free TCP port at or above <from>
  local p="$1"
  while ! port_free "$p"; do p=$((p + 1)); done
  echo "$p"
}

# The world. The github twin's DEFAULT seed has nothing worth refusing: one
# repository, one issue, and no pull request. This one has something at stake.
write_seed() {
  cat > "$WORK/twin/seed.json" <<'JSON'
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
}

boot() { # boot <port> -> starts the twin in $WORK/twin, records its pid
  local port="$1"
  mkdir -p "$WORK/twin/.pome-data/github"
  node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' \
    > "$WORK/twin/.pome-data/github/secret"
  write_seed
  # `exec` so $! is the CLI's own pid: SIGTERM then reaches the listener rather
  # than a subshell that would outlive it and keep the port bound.
  (
    cd "$WORK/twin" || exit 1
    export GITHUB_CLONE_DB=.pome/github.db
    exec $CLI twin start github --port "$port" --seed seed.json
  ) >"$WORK/twin.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 240); do
    if [ -f "$WORK/twin/.pome/twin-status.json" ] &&
      curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL the twin never came up on port $port; its log:"
  cat "$WORK/twin.log"
  exit 1
}

url() { jq -r .rest_url "$WORK/twin/.pome/twin-status.json"; }
agent() { echo "Authorization: Bearer $(jq -r .auth_token "$WORK/twin/.pome/twin-status.json")"; }

# The second identity, minted exactly the way the README mints it: an HS256 JWT
# over the twin's own signing secret, differing from the printed bearer in one
# claim. `login` is the only thing the merge gate consults.
mint() { # mint <login> -> a bearer header for that identity
  local token
  token="$(TWIN_AUTH_SECRET="$(cat "$WORK/twin/.pome-data/github/secret")" \
    node -e '
const { createHmac } = require("node:crypto");
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = b({ alg: "HS256", typ: "JWT" });
const body = b({ sid: "standalone", team_id: "tm_local", login: process.argv[1],
                 exp: Math.floor(Date.now() / 1000) + 86400 });
const sig = createHmac("sha256", process.env.TWIN_AUTH_SECRET)
  .update(head + "." + body).digest("base64url");
console.log(head + "." + body + "." + sig);
' "$1")"
  echo "Authorization: Bearer $token"
}

get() { # get <header> <path> -> response body on stdout
  curl -sf -H "$1" "$(url)$2"
}

code() { # code <header> <path> -> http status of a GET
  curl -s -o /dev/null -w '%{http_code}' -H "$1" "$(url)$2"
}

merge() { # merge <header> [pull] -> http status, body left in $WORK/merge.json
  curl -s -o "$WORK/merge.json" -w '%{http_code}' -X PUT -H "$1" \
    -H 'Content-Type: application/json' -d '{}' \
    "$(url)/repos/$REPO/pulls/${2:-1}/merge"
}

world() { # world <file> -> snapshot the twin's whole exported state
  get "$AGENT" "/_pome/state" | jq -S . > "$WORK/$1"
}

pr_shape() { # pr_shape -> "state merged sha"
  get "$AGENT" "/repos/$REPO/pulls/1" \
    | jq -r '"\(.state) \(.merged) \(.merge_commit_sha)"'
}

tape() { get "$AGENT" "/_pome/events" > "$WORK/tape.json"; }

PORT="$(pick_port "${POME_SHOWCASE_PORT:-3351}")"

echo "== booting the twin on port $PORT =="
boot "$PORT"
AGENT="$(agent)"
CI_BOT="$(mint ci-bot)"

echo "== the world =="
ok "the seeded pull request is open, unmerged" "$(pr_shape)" "open false null"
ok "the printed bearer is pome-agent" \
  "$(get "$AGENT" "/user" | jq -r .login)" "pome-agent"
# The seed names only `alice`; the twin adds `pome-agent` to every seeded repo,
# which is why the walkthrough has to mint its own powerless identity.
ok "pome-agent has push despite not being seeded" \
  "$(get "$AGENT" "/repos/$REPO/collaborators" | jq -r '[.[].login]|sort|join(",")')" \
  "alice,pome-agent"
ok "the minted bearer is ci-bot" \
  "$(get "$CI_BOT" "/user" | jq -r .login)" "ci-bot"

echo "== half 1: refused, not blindfolded =="
ok "ci-bot can READ the pull request" \
  "$(code "$CI_BOT" "/repos/$REPO/pulls/1")" "200"

world world-before.json

echo "== half 1: the refusal =="
ok "ci-bot's merge is refused with 403" "$(merge "$CI_BOT")" "403"
ok "the refusal is GitHub's own message" \
  "$(jq -r .message "$WORK/merge.json")" \
  "Must have push access to the repository to merge pull requests."
# GitHub names the OPERATION on a 403 rather than pointing at the docs root.
ok "the refusal names this operation in its docs url" \
  "$(jq -r .documentation_url "$WORK/merge.json")" \
  "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request"
ok "the body repeats the status as GitHub does" \
  "$(jq -r .status "$WORK/merge.json")" "403"

echo "== half 1: and the world did not move =="
ok "the pull request is untouched" "$(pr_shape)" "open false null"
world world-after.json
ok "the WHOLE exported world is byte-identical" \
  "$(cmp -s "$WORK/world-before.json" "$WORK/world-after.json" &&
     echo identical || echo changed)" "identical"

echo "== half 1: the tape =="
tape
ok "the refused merge is a row on the tape" \
  "$(jq '[.[]|select(.status==403 and (.path|endswith("/merge")))]|length>0' \
     "$WORK/tape.json")" "true"
# Invariants, not counts: WHICH rows may mutate is the property; how many reads
# surround them is this script's business.
ok "nothing has mutated state yet" \
  "$(jq '[.[]|select(.state_mutation)]|length' "$WORK/tape.json")" "0"
ok "the refusal carries no state_delta" \
  "$(jq -r '[.[]|select(.status==403)|.state_delta|type]|unique|join(",")' \
     "$WORK/tape.json")" "null"
ok "the refusal carries its own message" \
  "$(jq -r '[.[]|select(.status==403)|.error]|unique|join("|")' \
     "$WORK/tape.json")" \
  "Must have push access to the repository to merge pull requests."
ok "the refusal was judged semantically" \
  "$(jq -r '[.[]|select(.status==403)|.fidelity]|unique|join(",")' \
     "$WORK/tape.json")" "semantic"

echo "== half 2: same request, two bearers, nothing reconfigured =="
ok "ci-bot is refused again" "$(merge "$CI_BOT")" "403"
ok "pome-agent is allowed, same twin still running" "$(merge "$AGENT")" "200"
ok "the pull request is merged now" \
  "$(get "$AGENT" "/repos/$REPO/pulls/1" | jq -r '"\(.state) \(.merged)"')" \
  "closed true"
world world-merged.json
ok "THIS time the world moved" \
  "$(cmp -s "$WORK/world-after.json" "$WORK/world-merged.json" &&
     echo identical || echo changed)" "changed"
# The merge did the work rather than flipping a flag: main's copy of the file
# now carries the branch's value.
ok "the merge landed the branch's content on main" \
  "$(get "$AGENT" "/repos/$REPO/contents/src/timeout.ts" \
     | jq -r '.content|@base64d' | tr -d '\n')" \
  "export const ORDER_TIMEOUT_MS = 30000;"

echo "== half 2: the tape separates them without reading the status =="
tape
ok "every refusal left state alone" \
  "$(jq -r '[.[]|select(.status>=400)|.state_mutation]|unique|join(",")' \
     "$WORK/tape.json")" "false"
ok "every mutation was an allowed call" \
  "$(jq '[.[]|select(.state_mutation and .status>=300)]|length' \
     "$WORK/tape.json")" "0"
ok "every mutation carries a state_delta" \
  "$(jq '[.[]|select(.state_mutation and .state_delta==null)]|length' \
     "$WORK/tape.json")" "0"
ok "the bearer is redacted on every row" \
  "$(jq -r '[.[].request_headers.authorization]|unique|join(",")' \
     "$WORK/tape.json")" "[REDACTED]"
# The README tells a reader that `merge_pull_request` cannot be named in a tape
# check, because the recorder stamps no action name on its route. If that is
# ever widened, this goes red and the page's "One candidate was rejected"
# paragraph needs rewriting — which is exactly what it is here to catch.
ok "no /merge row carries an action name" \
  "$(jq -r '[.[]|select(.path|endswith("/merge"))|.tool//"null"]|unique|join(",")' \
     "$WORK/tape.json")" "null"

echo "== the other two ways to be told no =="
ok "a missing pull request is a modelled 404" "$(merge "$AGENT" 99)" "404"
ok "the 404 is GitHub's own message" \
  "$(jq -r .message "$WORK/merge.json")" "Pull request not found"
ok "an unmodelled route answers 501, not 404" \
  "$(code "$AGENT" "/repos/$REPO/actions/runs")" "501"
ok "and it says so under _twin.fidelity" \
  "$(curl -s -H "$AGENT" "$(url)/repos/$REPO/actions/runs" \
     | jq -r '._twin.fidelity')" "unsupported"
ok "and lists what it does serve" \
  "$(curl -s -H "$AGENT" "$(url)/repos/$REPO/actions/runs" \
     | jq '[._twin.supported_surfaces[]]|length>0')" "true"
tape
ok "the tape's fidelity column keeps the two apart" \
  "$(jq -r '[.[].fidelity]|unique|sort|join(",")' "$WORK/tape.json")" \
  "semantic,unsupported"
ok "every 404 was a modelled answer, not a gap" \
  "$(jq -r '[.[]|select(.status==404)|.fidelity]|unique|join(",")' \
     "$WORK/tape.json")" "semantic"

# The README warns that `/healthz`'s `access_control` catalog is a HOSTED
# dashboard surface, not this path's gate — a reader who sees `denied: 15` and
# assumes those 15 are refused here would be wrong. Pick one and prove it.
echo "== the /healthz catalog is not the gate =="
ok "add_collaborator is denied-by-default in the catalog" \
  "$(get "$AGENT" "/_pome/access-control" \
     | jq -r '.endpoints[]|select(.tool=="add_collaborator")|.default_allowed')" \
  "false"
ok "and this path performs it anyway" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$AGENT" \
     -H 'Content-Type: application/json' -d '{"permission":"push"}' \
     "$(url)/repos/$REPO/collaborators/dana")" "201"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS — both halves hold. No account, no key, no meter touched."
else
  echo "FAIL — $FAILS assertion(s) broke."
fi
echo "== stopping the twin =="
[ "$FAILS" -eq 0 ] || exit 1
