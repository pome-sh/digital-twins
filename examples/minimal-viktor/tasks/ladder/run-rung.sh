#!/usr/bin/env bash
# One trial of one ladder rung on one pinned model, through the coach door.
#
# usage: run-rung.sh <session_id> <agent_token> <model_slug> <rung_file>
#
# Two things this fixes relative to /tmp/viktor-sweep-run.sh, both of which
# would otherwise be confounds rather than results:
#
#   VIKTOR_MAX_STEPS — the example defaults to 32. Eight pull requests need
#   roughly five steps each (get PR, get files, read the changed file, act,
#   report), so 32 truncates the run and the score measures the step budget
#   instead of the model. Set high (120) and CHECKED afterwards: the summary
#   line prints the step count so a run that actually hit the ceiling is
#   visible rather than silently graded.
#
#   timeout — 280s is under the wall clock of a 40-step run on a slow model.
#   900s, still well inside the ~30-minute sandbox expiry.
set -uo pipefail
SID="$1"; TOK="$2"; MODEL="$3"; RUNG="$4"
AGENT="agt_8YVK4Rn13oSp5s9x5olo9"
SAFE=$(echo "$MODEL" | tr '/' '_')
LOG="/tmp/ladder-$(basename "$RUNG" .md)-${SAFE}-${SID}.log"

# Read the gateway key FIRST, from inside a pome-cloud checkout: `infisical`
# resolves its project from the working directory and returns an EMPTY value
# with exit 0 anywhere else.
cd /Users/aofu/conductor/workspaces/pome-cloud/praia-v2 || exit 1
export AI_GATEWAY_API_KEY="$(infisical secrets get AI_GATEWAY_API_KEY --env=prod --path=/control-plane --plain 2>/dev/null | tail -1)"
[ -z "$AI_GATEWAY_API_KEY" ] && { echo "FATAL: no AI_GATEWAY_API_KEY"; exit 1; }

TASK=$(awk '/^## Prompt/{f=1;next} /^## /{f=0} f' "$RUNG" | sed '/^$/d')
[ -z "$TASK" ] && { echo "FATAL: no ## Prompt in $RUNG"; exit 1; }

cd /Users/aofu/conductor/repos/digital-twins/examples/minimal-viktor || exit 1

VIKTOR_MODEL="$MODEL" \
VIKTOR_MAX_STEPS=120 \
POME_TASK="$TASK" \
POME_GITHUB_REST_URL="https://twins.pome.sh/github/s/$SID" \
POME_SLACK_REST_URL="https://twins.pome.sh/slack/s/$SID" \
POME_AUTH_TOKEN="$TOK" \
POME_OTEL_EXPORTER_OTLP_ENDPOINT="https://api.pome.sh/v1/sessions/$SID/traces" \
POME_OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $TOK" \
OTEL_SERVICE_NAME="$AGENT" \
OTEL_RESOURCE_ATTRIBUTES="pome.session_id=$SID,pome.agent_id=$AGENT" \
  timeout 900 npm run start > "$LOG" 2>&1
RC=$?

echo "=== exit=$RC model=$MODEL rung=$(basename "$RUNG" .md) sid=$SID"
# steps is the ceiling check: 120 means the run was truncated, not finished.
grep -oE '"steps":[0-9]+' "$LOG" | head -1
grep -oE '"error":"[^"]{0,200}' "$LOG" | head -2
echo "log=$LOG"
