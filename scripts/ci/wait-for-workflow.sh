#!/usr/bin/env bash
#
# Polls for another workflow's run on a given SHA. Waiting where no run exists polls
# to the timeout, so callers gate this on the events that actually produce one.
set -euo pipefail

workflow="${1:?usage: wait-for-workflow.sh <workflow-file> [sha]}"
sha="${2:-${GITHUB_SHA:?GITHUB_SHA or sha argument required}}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
token="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
interval_s="${WAIT_INTERVAL_S:-30}"
timeout_s="${WAIT_TIMEOUT_S:-1800}"
deadline=$((SECONDS + timeout_s))

api() {
  curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${token}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

echo "Waiting for workflow=${workflow} sha=${sha} (timeout ${timeout_s}s)"

while (( SECONDS < deadline )); do
  payload="$(api \
    "https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=5")"

  read -r status conclusion run_id <<<"$(
    node -e '
      const data = JSON.parse(process.argv[1]);
      const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
      if (runs.length === 0) {
        process.stdout.write("missing none 0\n");
        process.exit(0);
      }
      const pick = runs[0];
      process.stdout.write(`${pick.status} ${pick.conclusion ?? "none"} ${pick.id}\n`);
    ' "${payload}"
  )"

  if [[ "${status}" == "missing" ]]; then
    echo "no ${workflow} run for ${sha} yet; sleeping ${interval_s}s"
  elif [[ "${status}" != "completed" ]]; then
    echo "run ${run_id} status=${status}; sleeping ${interval_s}s"
  elif [[ "${conclusion}" == "success" ]]; then
    echo "run ${run_id} succeeded"
    exit 0
  else
    echo "::error::workflow ${workflow} run ${run_id} concluded ${conclusion} for ${sha}"
    exit 1
  fi

  sleep "${interval_s}"
done

echo "::error::timed out after ${timeout_s}s waiting for ${workflow} on ${sha}"
exit 1
