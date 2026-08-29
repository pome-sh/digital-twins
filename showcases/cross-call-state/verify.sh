#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Asserts both halves of the cross-call-state property against two LOCAL twin
# processes, so this showcase's README stays checkable rather than asserted.
#
# Half 1: state written by call N is readable at call N+1, and three writes
#         accumulate into one later read.
# Half 2: a second `twin start` — its own port, its own SQLite file — does NOT
#         see those writes, proved while BOTH twins are still running, so it is
#         isolation and not a reset.
#
# Self-contained on purpose. `twin start` prints its bearer on stdout and
# writes it to `.pome/twin-status.json`, so the mint is non-interactive: this
# script boots the twins it needs rather than assuming a human already did the
# interesting part. No account, no login, no API key, no meter — nothing here
# finalizes, and there is no hosted sandbox to finalize against.
#
# Needs: bash, node >= 24 (for npx), curl, jq. Set POME_CLI to point at a local
# build instead of the published CLI.
#
# Two rules this file exists to keep honest, both learned the hard way:
#   * The twin's credentials are read out of JSON with `jq`, never out of an
#     `export K="v"` file with `sed` — un-stripped quotes turn every curl into
#     exit 000 and a full red run that blames the wrong thing.
#   * Every tape assertion below is an INVARIANT, never a row count from a
#     hand-run. "No row on B's tape carries any authority but B's" survives
#     this script making one more read than the walkthrough does; "B's tape has
#     3 rows" does not.

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
  # Give each twin its graceful shutdown (it flushes the recorder and releases
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

# An injected TWIN_AUTH_SECRET would make both twins mint interchangeable
# bearers, which is a legitimate operator choice and would falsify one of the
# assertions below. This script owns its own environment, so it opts out.
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

boot() { # boot <name> <port> -> starts a twin in $WORK/<name>, records its pid
  local name="$1" port="$2"
  mkdir -p "$WORK/$name"
  # `exec` so $! is the CLI's own pid: SIGTERM then reaches the listener rather
  # than a subshell that would outlive it and keep the port bound.
  (
    cd "$WORK/$name" || exit 1
    export GITHUB_CLONE_DB=.pome/github.db
    exec $CLI twin start github --port "$port"
  ) >"$WORK/$name.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 240); do
    if [ -f "$WORK/$name/.pome/twin-status.json" ] &&
      curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL twin '$name' never came up on port $port; its log:"
  cat "$WORK/$name.log"
  exit 1
}

url() { jq -r .rest_url "$WORK/$1/.pome/twin-status.json"; }
auth() { echo "Authorization: Bearer $(jq -r .auth_token "$WORK/$1/.pome/twin-status.json")"; }

get() { # get <name> <path> -> response body on stdout
  curl -sf -H "$(auth "$1")" "$(url "$1")$2"
}

write() { # write <name> <method> <path> <json> -> http status on stdout
  curl -s -o /dev/null -w '%{http_code}' -X "$2" \
    -H "$(auth "$1")" -H 'Content-Type: application/json' -d "$4" \
    "$(url "$1")$3"
}

issue_shape() { # issue_shape <name> -> "state comments assignees"
  get "$1" "/repos/$REPO/issues/1" \
    | jq -r '"\(.state) \(.comments) \([.assignees[].login]|join(","))"'
}

authority() { url "$1" | sed -E 's#^https?://([^/]+).*#\1#'; }

# The assign write's assignees, before or after. One-line jq program on
# purpose: a `jq` filter re-wrapped to fit a width still runs, and a newline
# that lands inside a string literal quietly ends up in the output.
adelta() { # adelta <before|after> -> "" or "alice"
  jq -r --arg k "$1" \
    '[.[]|select(.path|endswith("/assignees"))][0].state_delta[$k].assignees|join("/")' \
    "$WORK/tape-a.json"
}

PORT_A="$(pick_port "${POME_SHOWCASE_PORT:-3341}")"
PORT_B="$(pick_port "$((PORT_A + 1))")"

echo "== booting twin A on port $PORT_A =="
boot a "$PORT_A"

echo "== half 1: the fresh world =="
ok "twin A starts open/0/none" "$(issue_shape a)" "open 0 "

echo "== half 1: write 1, read back through another surface =="
ok "write 1 (comment) is 201" \
  "$(write a POST "/repos/$REPO/issues/1/comments" \
     '{"body":"Repro: POST /orders 500s without currency."}')" "201"
ok "comment is readable at the next call" \
  "$(get a "/repos/$REPO/issues/1/comments" | jq 'length')" "1"

echo "== half 1: writes 2 and 3 =="
ok "write 2 (assign) is 201" \
  "$(write a POST "/repos/$REPO/issues/1/assignees" \
     '{"assignees":["alice"]}')" "201"
ok "write 3 (close) is 200" \
  "$(write a PATCH "/repos/$REPO/issues/1" '{"state":"closed"}')" "200"

echo "== half 1: all three survive into ONE later read =="
ok "twin A accumulated all three writes" "$(issue_shape a)" "closed 1 alice"

echo "== half 1: the tape =="
get a "/_pome/events" > "$WORK/tape-a.json"
# Invariants, not counts: which three rows mutated state and in what order is
# the property; how many reads surround them is this script's business.
ok "the 3 writes are the only mutations, in order" \
  "$(jq -r '[.[]|select(.state_mutation)|.method]|join(",")' \
     "$WORK/tape-a.json")" "POST,POST,PATCH"
ok "every mutation carries a state_delta" \
  "$(jq '[.[]|select(.state_mutation and .state_delta==null)]|length' \
     "$WORK/tape-a.json")" "0"
ok "no read carries a state_delta" \
  "$(jq '[.[]|select((.state_mutation|not) and .state_delta!=null)]|length' \
     "$WORK/tape-a.json")" "0"
ok "the assign row's delta is [] -> [alice]" \
  "$(adelta before)->$(adelta after)" "->alice"
ok "add_issue_comment stamped on the comment write" \
  "$(jq '[.[]|select(.tool=="add_issue_comment")]|length' \
     "$WORK/tape-a.json")" "1"
ok "every row was judged semantically" \
  "$(jq -r '[.[].fidelity]|unique|join(",")' "$WORK/tape-a.json")" "semantic"

echo "== booting twin B on port $PORT_B (same twin, its own store) =="
boot b "$PORT_B"
ok "the two twins are different processes" \
  "$([ "$(authority a)" != "$(authority b)" ] && echo differ || echo same)" \
  "differ"
ok "twin A's store file exists" \
  "$([ -f "$WORK/a/.pome/github.db" ] && echo yes || echo no)" "yes"
ok "twin B's store is a different file" \
  "$([ "$WORK/a/.pome/github.db" != "$WORK/b/.pome/github.db" ] &&
     [ -f "$WORK/b/.pome/github.db" ] && echo yes || echo no)" "yes"

echo "== half 2: none of it crossed =="
ok "twin B sees the untouched world" "$(issue_shape b)" "open 0 "
ok "twin B sees no comment" \
  "$(get b "/repos/$REPO/issues/1/comments" | jq 'length')" "0"

echo "== half 2: isolation, not a reset — both alive at once =="
ok "twin A STILL holds its three writes" "$(issue_shape a)" "closed 1 alice"
ok "twin B STILL holds none of them" "$(issue_shape b)" "open 0 "

echo "== half 2: the tape is per-process too =="
get b "/_pome/events" > "$WORK/tape-b.json"
ok "twin B's tape records no mutation" \
  "$(jq '[.[]|select(.state_mutation)]|length' "$WORK/tape-b.json")" "0"
# The session id is NOT the boundary locally: a standalone twin serves the one
# fixed sid, so both tapes read `standalone`. The Host the request arrived on
# is what names the process, and it is on every row.
ok "both tapes serve the same session id" \
  "$(jq -rs 'add|[.[].path|split("/")[2]]|unique|join(",")' \
     "$WORK/tape-a.json" "$WORK/tape-b.json")" "standalone"
ok "no row on B's tape has any authority but B's" \
  "$(jq --arg a "$(authority b)" \
     '[.[]|select(.request_headers.host != $a)]|length' \
     "$WORK/tape-b.json")" "0"
ok "no twin-A row appears on twin-B's tape" \
  "$(jq --arg a "$(authority a)" \
     '[.[]|select(.request_headers.host == $a)]|length' \
     "$WORK/tape-b.json")" "0"

echo "== half 2: the bearers are not interchangeable =="
ok "twin A's token is refused by twin B" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth a)" \
     "$(url b)/repos/$REPO/issues/1")" "401"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS — both halves hold. No account, no key, no meter touched."
else
  echo "FAIL — $FAILS assertion(s) broke."
fi
echo "== stopping both twins =="
[ "$FAILS" -eq 0 ] || exit 1
