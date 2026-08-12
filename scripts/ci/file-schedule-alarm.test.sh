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
: >"$state"
: >"$log"

# A fake `gh` that logs every invocation and simulates exactly the two calls
# file-schedule-alarm.sh depends on: `issue list` (existing tracking issue,
# if any) and `label create` / `issue create` / `issue comment` / `issue
# close` (all logged, never real).
cat >"$work/gh" <<'STUB'
#!/usr/bin/env bash
log="$(dirname "$0")/gh.log"
state="$(dirname "$0")/state"
printf '%s\n' "$*" >>"$log"
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

# 1. First failure, no tracking issue yet: files a NEW issue naming the failure.
run failure "REPO_POLICY_TOKEN is required for schedule drift checks (GITHUB_TOKEN cannot read branch protection)."
assert "$(cat "$state")" "42"
grep -q "^issue create" "$log"

# 2. Second failure (a DIFFERENT scheduled workflow's failure, reusing the same
#    issue only if it shares the label — here the same repo-policy alarm fires
#    again): must COMMENT on the existing issue, never open a second one.
: >"$log"
run failure "REPO_POLICY_TOKEN is required for schedule drift checks (GITHUB_TOKEN cannot read branch protection)."
assert "$(cat "$state")" "42"
grep -q "^issue comment 42" "$log"
if grep -q "^issue create" "$log"; then
  echo "FAIL: a second failure re-opened a new issue instead of commenting on the existing one" >&2
  exit 1
fi

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

echo "✅ file-schedule-alarm.test.sh passed (dry run — every gh call above was logged, never executed)"
echo "--- gh.log for the reuse-and-comment case (step 2) ---"
