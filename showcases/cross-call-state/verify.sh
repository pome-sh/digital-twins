#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Asserts both halves of the cross-call-state property against live hosted
# sandboxes, so this showcase's README stays checkable rather than asserted.
#
# Half 1: state written by call N is readable at call N+1, and three writes
#         accumulate into one later read.
# Half 2: a second sandbox of the same twin does NOT see those writes — proved
#         while BOTH sandboxes are still alive, so it is isolation and not a
#         reset.
#
# Ungraded on purpose: it never calls finalize, so it burns 0 agent evals.
# Needs a logged-in CLI (`npx @pome-sh/cli@latest login`), curl and jq.
# No ANTHROPIC_API_KEY — the single-seat rule.

set -euo pipefail

CLI="${POME_CLI:-npx @pome-sh/cli@latest}"
REPO="acme/api"
FAILS=0
SB1_ID=""
SB2_ID=""
WORK="$(mktemp -d)"

cleanup() {
  local code=$?
  for id in "$SB1_ID" "$SB2_ID"; do
    [ -n "$id" ] || continue
    echo "  stopping $id"
    $CLI sandbox stop "$id" --discard >/dev/null 2>&1 || \
      echo "  WARN: could not stop $id — it expires on its own in 30m"
  done
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1 on PATH"; exit 2; }; }
need curl
need jq

# ok <label> <actual> <expected>
ok() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %-46s %s\n' "$1" "$2"
  else
    printf '  FAIL %-46s got %s, want %s\n' "$1" "$2" "$3"
    FAILS=$((FAILS + 1))
  fi
}

mint() { # mint <name> -> echoes session id, writes $WORK/<name>.env
  $CLI sandbox create --twin github --secrets-file "$WORK/$1.env" \
    --format json 2>/dev/null | jq -r '.session_id'
}

# Read a var out of a secrets file without leaking it into the environment of
# anything else. The file is `export K="V"` lines, mode 0600 — the values are
# QUOTED, so strip the quotes that `source` would have stripped for us.
sget() {
  sed -n "s/^export $2=//p" "$WORK/$1.env" | sed 's/^"//; s/"$//'
}

get() { # get <name> <path> -> response body on stdout
  curl -sf -H "Authorization: Bearer $(sget "$1" POME_AUTH_TOKEN)" \
    "$(sget "$1" POME_GITHUB_REST_URL)$2"
}

write() { # write <name> <method> <path> <json> -> http status on stdout
  curl -s -o /dev/null -w '%{http_code}' -X "$2" \
    -H "Authorization: Bearer $(sget "$1" POME_AUTH_TOKEN)" \
    -H 'Content-Type: application/json' -d "$4" \
    "$(sget "$1" POME_GITHUB_REST_URL)$3"
}

issue_shape() { # issue_shape <name> -> "state comments assignees"
  get "$1" "/repos/$REPO/issues/1" \
    | jq -r '"\(.state) \(.comments) \([.assignees[].login]|join(","))"'
}

echo "== minting sandbox 1 =="
SB1_ID="$(mint sb1)"
echo "   $SB1_ID"

echo "== half 1: the fresh world =="
ok "sb1 starts open/0/none" "$(issue_shape sb1)" "open 0 "

echo "== half 1: three writes =="
ok "write 1 (comment) is 201" \
  "$(write sb1 POST "/repos/$REPO/issues/1/comments" \
     '{"body":"Repro: POST /orders 500s without currency."}')" "201"
ok "comment is readable at the next call" \
  "$(get sb1 "/repos/$REPO/issues/1/comments" | jq 'length')" "1"
ok "write 2 (assign) is 201" \
  "$(write sb1 POST "/repos/$REPO/issues/1/assignees" \
     '{"assignees":["alice"]}')" "201"
ok "write 3 (close) is 200" \
  "$(write sb1 PATCH "/repos/$REPO/issues/1" '{"state":"closed"}')" "200"

echo "== half 1: all three survive into ONE later read =="
ok "sb1 accumulated all three writes" "$(issue_shape sb1)" "closed 1 alice"

echo "== half 1: the tape =="
get sb1 "/_pome/events" > "$WORK/tape1.json"
ok "tape has 6 rows in order" "$(jq 'length' "$WORK/tape1.json")" "6"
ok "state_mutation true on exactly the 3 writes" \
  "$(jq '[.[]|select(.state_mutation)]|length' "$WORK/tape1.json")" "3"
ok "add_issue_comment stamped on the comment write" \
  "$(jq -r '[.[]|select(.tool=="add_issue_comment")]|length' \
     "$WORK/tape1.json")" "1"
ok "the write rows carry a state_delta" \
  "$(jq '[.[]|select(.state_mutation and .state_delta!=null)]|length' \
     "$WORK/tape1.json")" "3"

echo "== minting sandbox 2 (same twin, fresh) =="
SB2_ID="$(mint sb2)"
echo "   $SB2_ID"
ok "the two sandboxes are different" \
  "$([ "$SB1_ID" != "$SB2_ID" ] && echo differ || echo same)" "differ"

echo "== half 2: none of it crossed =="
ok "sb2 sees the untouched world" "$(issue_shape sb2)" "open 0 "
ok "sb2 sees no comment" \
  "$(get sb2 "/repos/$REPO/issues/1/comments" | jq 'length')" "0"

echo "== half 2: isolation, not a reset — both alive at once =="
ok "sb1 STILL holds its three writes" "$(issue_shape sb1)" "closed 1 alice"
ok "sb2 STILL holds none of them" "$(issue_shape sb2)" "open 0 "

echo "== half 2: the tape is per-sandbox too =="
get sb2 "/_pome/events" > "$WORK/tape2.json"
# Counted as invariants, not as literals: how many reads this script happens to
# make against sb2 is an implementation detail, but "every row is sb2's and none
# is sb1's" is the property.
ok "sb2's tape records no mutation" \
  "$(jq '[.[]|select(.state_mutation)]|length' "$WORK/tape2.json")" "0"
ok "no sb2 row is scoped to anything but sb2" \
  "$(jq -r --arg id "$SB2_ID" \
     '[.[]|select(.path|contains($id)|not)]|length' "$WORK/tape2.json")" "0"
ok "no sb1 row appears on sb2's tape" \
  "$(jq -r --arg id "$SB1_ID" \
     '[.[]|select(.path|contains($id))]|length' "$WORK/tape2.json")" "0"
ok "sb2's tape is shorter than sb1's 6-row run" \
  "$([ "$(jq length "$WORK/tape2.json")" -lt 6 ] && echo yes || echo no)" "yes"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS — both halves hold. 0 agent evals burned (nothing finalized)."
else
  echo "FAIL — $FAILS assertion(s) broke."
fi
echo "== cleaning up =="
[ "$FAILS" -eq 0 ] || exit 1
