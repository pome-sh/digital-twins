#!/usr/bin/env bash
# F-1230 — a scheduled workflow that fails tells nobody.
#
# Shared filing logic for `.github/workflows/schedule-alarm.yml`, the reusable
# workflow every schedule-triggered workflow in this repo calls with a
# `failure()`-guarded job (see repo-policy.yml and the
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
#
# Every `gh` call this script NEEDS is unguarded, and the script exits non-zero
# if one fails. That is the opposite of release-alarm.yml's in-job alerting
# steps, which are `continue-on-error: true` so that alerting cannot masquerade
# as a release failure — there, alerting is a side errand of a job whose real
# subject is the release. Here it is the entire purpose of a SEPARATE job, so
# swallowing a 403 (a caller that forgot `issues: write`, an org token policy,
# a rate limit) would reproduce this ticket's own defect inside the alarm: a
# green check standing in for a signal that reached nobody.
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

# `gh issue create --label X` FAILS OUTRIGHT if X does not exist in the repo,
# and none of the `schedule-alarm:*` labels existed on pome-sh/digital-twins
# when this shipped — so without this line the first real failure would have
# filed nothing. Create-on-demand rather than a one-off manual `gh label
# create` per alarm, so a new alarm needs no out-of-band repo setup step that
# is remembered right up until it isn't. `|| true` because the call also fails
# when the label ALREADY exists, which is the steady state and not an error;
# the labelled `gh issue create` below is what actually asserts the label is
# usable, and it is unguarded.
gh label create "$label" \
  --color B60205 \
  --description "a scheduled workflow's own alarm, filed by schedule-alarm.yml" \
  --repo "$repo" >/dev/null 2>&1 || true

# Unguarded on purpose. With no match this prints an empty string and exits 0
# (gh renders a null scalar as ""), so "no open issue" is already distinct from
# "the lookup failed" — and swallowing the latter would read as "no open issue"
# and file a duplicate on every run. The label is guaranteed to exist by here.
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
  gh issue comment "$existing" --repo "$repo" --body-file "${body}.c"
else
  # Deliberately NO un-labelled fallback. An issue filed without "$label" is
  # invisible to the `gh issue list --label` lookup above, so every subsequent
  # failure would open ANOTHER new issue and no recovery could ever close any
  # of them — the "new issue per run" behaviour this file exists to avoid,
  # arrived at silently. If the label cannot be applied, failing here is the
  # honest outcome.
  gh issue create --repo "$repo" --title "$title" \
    --body-file "$body" --label "$label"
fi
