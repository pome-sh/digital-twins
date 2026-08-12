#!/usr/bin/env bash
# F-1230 — a scheduled workflow that fails tells nobody.
#
# Shared filing logic for `.github/workflows/schedule-alarm.yml`, the reusable
# workflow every schedule-triggered workflow in this repo calls with a
# `failure()`-guarded job (see repo-policy.yml, secret-scan.yml, and the
# meta-alarm job in release-alarm.yml). Copies check-release-staleness.yml's
# retired pattern (#300, deleted in a3c9441 alongside the Changesets flow it
# watched): a constant title, ONE long-lived tracking issue reused across
# consecutive failures rather than a new issue per run, one label per alarm so
# several alarms never collide on the same issue, and a body naming what
# failed plus the run URL.
#
# Green is asserted as hard as red (same stance as release-alarm.mjs): a
# recovered workflow CLOSES its tracking issue rather than leaving it open,
# because a stale open issue teaches people to skim past the next real one.
#
# Usage:
#   OUTCOME=failure|success \
#   TITLE="..." LABEL="..." DETAIL="..." RUN_URL="..." \
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo \
#     bash scripts/ci/file-schedule-alarm.sh
set -u

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
  --json number --jq '.[0].number' 2>/dev/null || true)"

if [ "$outcome" = "success" ]; then
  if [ -z "$existing" ]; then
    echo "outcome=success, no open issue labelled ${label} — nothing to close."
    exit 0
  fi
  body="$(mktemp)"
  {
    printf 'Green again. Closed by schedule-alarm: %s\n' "$run_url"
  } >"$body"
  gh issue comment "$existing" --repo "$repo" --body-file "$body" || true
  gh issue close "$existing" --repo "$repo" || true
  exit 0
fi

# outcome = failure
detail="${DETAIL:-(no detail was provided)}"
body="$(mktemp)"
{
  printf '%s\n\n' "$detail"
  printf 'Detected by schedule-alarm: %s\n\n' "$run_url"
  printf 'This issue is reused across consecutive failures (commented on, not re-filed) and closes itself once the run is green again — so a workflow that stays broken stays visible instead of burying itself.\n'
} >"$body"

if [ -n "$existing" ]; then
  { printf 'Still failing on the latest run.\n\n'; cat "$body"; } >"${body}.c"
  gh issue comment "$existing" --repo "$repo" --body-file "${body}.c" || true
else
  gh issue create --repo "$repo" --title "$title" \
    --body-file "$body" --label "$label" ||
    gh issue create --repo "$repo" --title "$title" --body-file "$body" || true
fi
