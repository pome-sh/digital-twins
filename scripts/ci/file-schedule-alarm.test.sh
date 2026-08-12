#!/usr/bin/env bash
# Regression + dry-run demonstration for scripts/ci/file-schedule-alarm.sh
# (F-1230). Stubs `gh` on PATH so no real GitHub issue is ever created —
# every call the script would have made is appended to a log file instead,
# which is also the "show the payload" evidence the ticket asks for.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/file-schedule-alarm.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

state="$work/state"   # "" = no open issue yet, or an issue number
log="$work/gh.log"
bodies="$work/bodies.log"
: >"$state"
: >"$log"
: >"$bodies"

# A fake `gh` that logs every invocation and simulates exactly the two calls
# file-schedule-alarm.sh depends on: `issue list` (existing tracking issue,
# if any) and `label create` / `issue create` / `issue comment` / `issue
# close` (all logged, never real).
cat >"$work/gh" <<'STUB'
#!/usr/bin/env bash
log="$(dirname "$0")/gh.log"
state="$(dirname "$0")/state"
printf '%s\n' "$*" >>"$log"
# Keep the rendered body, not just the call name: `--body-file` is logged as a
# path to a temp file that is gone by the time the assertions run, so without
# this an EMPTY or misbuilt body passes every grep below.
args="$*" # NOT `${*##…}`: that applies the pattern element-wise, not to the join
if [[ "$args" == *--body-file* ]]; then
  f="${args##*--body-file }"
  cat "${f%% *}" >>"$(dirname "$0")/bodies.log"
fi
# When this file exists, every MUTATING call 403s, the way a caller job that
# forgot `issues: write` makes them. `issue list` still works, so the failure
# lands squarely on the call that is supposed to file the alarm.
if [ -e "$(dirname "$0")/deny" ] && [ "$1 $2" != "issue list" ]; then
  echo "HTTP 403: Resource not accessible by integration" >&2
  exit 1
fi
case "$1 $2" in
"issue list")
  cat "$state"
  ;;
"issue create")
  echo "42" >"$state"
  ;;
"issue close")
  : >"$state"
  ;;
esac
exit 0
STUB
chmod +x "$work/gh"
export PATH="$work:$PATH"

run() {
  OUTCOME="$1" TITLE="the repo-policy weekly cron is failing" \
    LABEL="schedule-alarm:repo-policy" DETAIL="$2" \
    RUN_URL="https://github.com/pome-sh/pome-twins/actions/runs/999" \
    GITHUB_REPOSITORY="pome-sh/pome-twins" \
    bash "$SCRIPT"
}

assert() { [ "$1" = "$2" ] || { echo "FAIL: expected '$2', got '$1'" >&2; exit 1; }; }

DETAIL_1="REPO_POLICY_TOKEN is required for schedule drift checks (GITHUB_TOKEN cannot read branch protection)."

# 1. First failure, no tracking issue yet: files a NEW issue naming the failure.
run failure "$DETAIL_1"
assert "$(cat "$state")" "42"
grep -q "^issue create" "$log"
# The label is applied on create, because the label is the ONLY key the reuse
# lookup has: an issue filed without it is invisible to every later run, so each
# failure would file a fresh one and no recovery could close any of them.
grep -q -- "--label schedule-alarm:repo-policy" "$log"
# And the body actually carries what failed plus the run URL, per the ticket.
grep -qF "$DETAIL_1" "$bodies"
grep -qF "https://github.com/pome-sh/pome-twins/actions/runs/999" "$bodies"

# 2. Second failure (a DIFFERENT scheduled workflow's failure, reusing the same
#    issue only if it shares the label — here the same repo-policy alarm fires
#    again): must COMMENT on the existing issue, never open a second one.
: >"$log"
run failure "$DETAIL_1"
assert "$(cat "$state")" "42"
grep -q "^issue comment 42" "$log"
if grep -q "^issue create" "$log"; then
  echo "FAIL: a second failure re-opened a new issue instead of commenting on the existing one" >&2
  exit 1
fi
# Keep this call's log for the evidence footer, before steps 3-5 truncate it.
cp "$log" "$work/gh.reuse.log"

# 3. Recovery: closes the existing tracking issue rather than leaving it open.
: >"$log"
run success ""
assert "$(cat "$state")" ""
grep -q "^issue close 42" "$log"

# 4. Recovery with no open issue: a no-op, not an error.
: >"$log"
run success ""
if grep -q "^issue close" "$log"; then
  echo "FAIL: closed an issue that was not open" >&2
  exit 1
fi

# 5. The alarm cannot fail silently. Every mutating `gh` call 403s, the way a
#    caller job that forgot `permissions: issues: write` makes them. Before this
#    the script was `set -u` with `|| true` on every call, so it exited 0 and
#    the alarm job went green having filed nothing — this ticket's own defect,
#    reproduced inside the alarm.
: >"$log"
: >"$state"
touch "$work/deny"
if run failure "$DETAIL_1"; then
  echo "FAIL: gh 403'd on every mutating call and the alarm still exited 0" >&2
  exit 1
fi
grep -q "^issue create" "$log" # it did try
rm -f "$work/deny"

# 6. An unrecognised outcome is a hard error, never a silent no-op. The
#    reusable workflow deliberately has no `if:` on the outcome value, so this
#    exit path is reachable from a real caller with e.g. `outcome: Failure`.
if run Failure ""; then
  echo "FAIL: an unrecognised OUTCOME exited 0 instead of failing loudly" >&2
  exit 1
fi

echo "✅ file-schedule-alarm.test.sh passed (dry run — every gh call above was logged, never executed)"
echo "--- gh.log for the reuse-and-comment case (step 2) ---"
cat "$work/gh.reuse.log"
