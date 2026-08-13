#!/usr/bin/env bash
# F-696 — assert public-repo policy for pome-twins main.
# F-1212 — the live drift check used to call the legacy
# GET .../branches/{branch}/protection + GET .../rulesets endpoints, which
# need Administration:read. GITHUB_TOKEN cannot hold that scope, so the
# check depended on a hand-minted PAT (REPO_POLICY_TOKEN) that never existed
# — the weekly cron has been red since it shipped and the live step never
# ran once. GET .../rules/branches/{branch} returns the same effective rules
# (pull_request review count, required status checks, non-fast-forward) for
# a metadata-scoped GITHUB_TOKEN, no PAT needed.
#
# The property that matters: this must FAIL, not silently pass, if the rules
# it reads stop covering a policy it asserts (ruleset deleted, moved to
# legacy branch protection, moved to org level, endpoint drops a rule type).
# An empty/missing rules array, or any policy with no matching rule, is a
# hard failure naming that policy — never treated as "nothing to check".
#
# NOT covered by this endpoint (dropped, not silently assumed true): the
# ruleset's bypass_actors (founder-team bypass). Reading that needs the
# admin-scoped ruleset detail endpoint this change deliberately stops
# calling. See the PR for F-1212.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pome-sh/pome-twins}"
BRANCH="${POLICY_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required (ordinary Actions token; no PAT needed)}"
RULES_OUT="$(mktemp)"
trap 'rm -f "${RULES_OUT}"' EXIT

# F-1180 — the contexts live in config/required-checks.json. A second
# hand-maintained copy of the same list is the F-1135 shape: one goes stale
# while both still look like they are watching.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUIRED_CHECKS_FILE="${REQUIRED_CHECKS_FILE:-${REPO_ROOT}/config/required-checks.json}"
# Read into a variable first (not `mapfile < <(...)`, which is bash 4+ and
# swallows the exit status): `set -e` must still fire if the file is unreadable.
REQUIRED_CHECKS_RAW="$(
  REQUIRED_CHECKS_FILE="${REQUIRED_CHECKS_FILE}" node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.env.REQUIRED_CHECKS_FILE, "utf8"));
    if (!Array.isArray(cfg.contexts) || cfg.contexts.length === 0) {
      console.error("::error::config/required-checks.json must list a non-empty contexts array");
      process.exit(1);
    }
    process.stdout.write(cfg.contexts.join("\n") + "\n");
  '
)"
REQUIRED_CHECKS=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && REQUIRED_CHECKS+=("${line}")
done <<<"${REQUIRED_CHECKS_RAW}"

api() {
  curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

fail_http() {
  local code="$1"
  local label="$2"
  local dest="$3"
  if [[ "${code}" != "200" ]]; then
    echo "::error::unexpected HTTP ${code} reading ${label}"
    cat "${dest}" >&2 || true
    exit 1
  fi
}

echo "Asserting branch rules policy for ${REPO}@${BRANCH}"

if [[ -n "${RULES_JSON:-}" ]]; then
  cp "${RULES_JSON}" "${RULES_OUT}"
else
  code="$(api -o "${RULES_OUT}" -w '%{http_code}' \
    "https://api.github.com/repos/${REPO}/rules/branches/${BRANCH}")"
  fail_http "${code}" "branch rules for ${BRANCH}" "${RULES_OUT}"
fi

RULES_JSON_PATH="${RULES_OUT}" \
REQUIRED_CHECKS_JSON="$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").trim().split(/\n/)))')" \
POLICY_BRANCH="${BRANCH}" \
node <<'NODE'
const fs = require("fs");
const rules = JSON.parse(fs.readFileSync(process.env.RULES_JSON_PATH, "utf8"));
const required = JSON.parse(process.env.REQUIRED_CHECKS_JSON);
const branch = process.env.POLICY_BRANCH;
const errors = [];

// Coverage, not just correctness: an empty/missing response must hard-fail,
// never read as "no rules configured, nothing to check".
if (!Array.isArray(rules) || rules.length === 0) {
  console.error(`::error::GET rules/branches/${branch} returned no rules — treating this as a hard failure, not "nothing to check" (a ruleset move/deletion must be visible, not silently pass)`);
  process.exit(1);
}

const POLICIES = ["pull_request", "required_status_checks", "non_fast_forward"];

function findRule(type) {
  return rules.find((r) => r.type === type);
}

// --- pull_request: 0 required reviews (founder team merges on green CI), thread resolution required ---
const prRule = findRule("pull_request");
if (!prRule?.parameters) {
  errors.push(`missing rule: pull_request (policy: PR required with 0 approving reviews + resolved threads)`);
} else {
  const params = prRule.parameters;
  if (Number(params.required_approving_review_count) !== 0) {
    errors.push("pull_request.required_approving_review_count must be 0");
  }
  if (params.required_review_thread_resolution !== true) {
    errors.push("pull_request.required_review_thread_resolution must be true");
  }
}

// --- required_status_checks: strict + contexts agree with config/required-checks.json in BOTH directions ---
const checksRule = findRule("required_status_checks");
if (!checksRule?.parameters) {
  errors.push(`missing rule: required_status_checks (policy: strict required checks matching config/required-checks.json)`);
} else {
  if (checksRule.parameters.strict_required_status_checks_policy !== true) {
    errors.push("required_status_checks.strict_required_status_checks_policy must be true");
  }
  const liveContexts = (checksRule.parameters.required_status_checks ?? []).map((c) => c.context);
  for (const ctx of required) {
    if (!liveContexts.includes(ctx)) {
      errors.push(`required_status_checks missing context present in config/required-checks.json: ${ctx}`);
    }
  }
  for (const ctx of liveContexts) {
    if (!required.includes(ctx)) {
      errors.push(`required_status_checks has a live context absent from config/required-checks.json: ${ctx}`);
    }
  }
}

// --- non_fast_forward: force-push protection on the branch ---
const ffRule = findRule("non_fast_forward");
if (!ffRule) {
  errors.push(`missing rule: non_fast_forward (policy: no force-push to ${branch})`);
}

console.log(`read ${rules.length} rule(s) from the API; asserting ${POLICIES.length} polic(y/ies): ${POLICIES.join(", ")}`);

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error("rules payload:", JSON.stringify(rules, null, 2));
  process.exit(1);
}
console.log(`ok: pull_request (0 reviews, resolved threads) + required_status_checks (strict, contexts match config/required-checks.json) + non_fast_forward, all present in ${rules.length} live rule(s) for ${branch}`);
console.log("required contexts:", required.join(", "));
NODE
