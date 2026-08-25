#!/usr/bin/env bash
#
# Files or updates one long-lived tracking issue per alarm title, and closes it on
# recovery. A new issue per failed run is an alarm people learn to skim.
set -euo pipefail

outcome="${OUTCOME:?OUTCOME (failure|success) required}"
title="${TITLE:?TITLE required}"
label="${LABEL:?LABEL required}"
run_url="${RUN_URL:?RUN_URL required}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"

case "$outcome" in
failure | success) ;;
*)
  echo "OUTCOME must be 'failure' or 'success', got '${outcome}'" >&2
  exit 1
  ;;
esac

gh label create "$label" \
  --color B60205 \
  --description "a scheduled workflow's own alarm, filed by schedule-alarm.yml" \
  --repo "$repo" >/dev/null 2>&1 || true

existing="$(gh issue list --repo "$repo" --state open --label "$label" \
  --json number --jq '.[0].number')"

if [ "$outcome" = "success" ]; then
  if [ -z "$existing" ]; then
    echo "outcome=success, no open issue labelled ${label} — nothing to close."
    exit 0
  fi
  body="$(mktemp)"
  {
    printf 'Green again. Closed by schedule-alarm: %s\n' "$run_url"
  } >"$body"
  gh issue comment "$existing" --repo "$repo" --body-file "$body"
  gh issue close "$existing" --repo "$repo"
  exit 0
fi

detail="${DETAIL:-(no detail was provided)}"
body="$(mktemp)"
{
  printf '%s\n\n' "$detail"
  printf 'Detected by schedule-alarm: %s\n\n' "$run_url"
  printf 'This issue is reused across consecutive failures (commented on, not re-filed) and closes itself once the run is green again — so a workflow that stays broken stays visible instead of burying itself.\n'
} >"$body"

if [ -n "$existing" ]; then
  { printf 'Still failing on the latest run.\n\n'; cat "$body"; } >"${body}.c"
  gh issue comment "$existing" --repo "$repo" --body-file "${body}.c"
else
  gh issue create --repo "$repo" --title "$title" \
    --body-file "$body" --label "$label"
fi
