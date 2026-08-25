#!/usr/bin/env bash
# Assert the protected-main policy: pull request, review, required checks.
#
# The live check reads GET .../rules/branches/{branch}, which an ordinary
# GITHUB_TOKEN can call. Do NOT move it to GET .../branches/{branch}/protection
# or GET .../rulesets/{id}: both need Administration:read, which GITHUB_TOKEN
# cannot hold. /protection is auth-gated outright, and /rulesets/{id} answers
# 200 for any caller on a public repo but ELIDES bypass_actors without that
# scope — so it would pass while checking nothing. This endpoint returns the
# same effective rules (pull_request review count, required status checks,
# non-fast-forward, deletion) for a metadata-scoped GITHUB_TOKEN, no PAT
# needed.
#
# The property that matters: this must FAIL, not silently pass, if the rules
# it reads stop covering a policy it asserts (ruleset deleted, disabled or
# switched to `evaluate`, protection moved to classic branch protection,
# endpoint drops a rule type). An empty/missing rules array, or any policy
# with no matching rule, is a hard failure naming that policy — never
# treated as "nothing to check".
#
# It returns only rules from rulesets whose enforcement is `active`. A ruleset flipped to
# `evaluate` or `disabled` drops out entirely, so its rules vanish from this
# payload and the empty-array branch below hard-fails. That is why enforcement
# is not asserted separately — losing it cannot present as a green run.
# Rules inherited from an ORG-level ruleset do still appear here (with
# ruleset_source_type "Organization"). They count towards coverage — the policy
# is that main is covered, not that a particular ruleset object covers it — but
# they are held to the same terms: an org rule contributing a required context
# not in config/required-checks.json is still a failure, because an unexpected
# required context is exactly the drift this check exists to surface.
#
# NOT covered live (dropped, not silently assumed true) — both are named in the
# run log on success so a reader is never told coverage is total:
#
#   1. The ruleset's bypass_actors (founder-team bypass). GitHub elides the bypass_actors FIELD
# for callers without Administration:read — the .../rulesets/{id} endpoint
# itself is readable (it answers 200 even unauthenticated on this public repo),
# but the field is simply absent, so asserting on it would fail OPEN for
# GITHUB_TOKEN. Left unwatched rather than asserted-on-an-absent-field.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pome-sh/digital-twins}"
BRANCH="${POLICY_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required (ordinary Actions token; no PAT needed)}"
RULES_OUT="$(mktemp)"
trap 'rm -f "${RULES_OUT}"' EXIT

# The contexts live in config/required-checks.json. A second hand-maintained
# copy of the same list goes stale
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
  # Fixture seam for assert-repo-policy.test.mjs only. Say so loudly: a run
  # that reads a fixture asserts nothing about the live repo, and must never
  # be mistaken for a drift check that passed. repo-policy.yml never sets it
  # (asserted by the regression test).
  echo "::warning::RULES_JSON is set — reading fixture ${RULES_JSON}, NOT the live GitHub API. This run proves nothing about ${REPO}@${BRANCH}."
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

const POLICIES = ["pull_request", "required_status_checks", "non_fast_forward", "deletion"];

// The declared set above is only worth printing if it is derived from work
// actually done. `asserted` is added to by each block below at the point it
// has really run its assertions; the cross-check after them fails if a block
// stops asserting a declared policy. Without this, deleting an assertion
// block leaves the summary still claiming that policy was checked — the same
// decorative-denominator defect this script exists to catch elsewhere.
const asserted = new Set();

// Every rule of a type, not the first. Two rulesets can both match main (a
// repo one plus an org one), and the endpoint returns a rule per source. With
// `find`, a second, laxer pull_request rule — or extra contexts contributed by
// a second required_status_checks rule — would go unread while the summary
// still reported the policy as asserted.
function findRules(type) {
  return rules.filter((r) => r.type === type);
}

// --- pull_request: 0 required reviews (founder team merges on green CI), thread resolution required ---
const prRules = findRules("pull_request");
if (prRules.length === 0 || prRules.some((r) => !r.parameters)) {
  errors.push(`missing rule: pull_request (policy: PR required with 0 approving reviews + resolved threads)`);
} else {
  for (const { parameters: params } of prRules) {
    if (Number(params.required_approving_review_count) !== 0) {
      errors.push("pull_request.required_approving_review_count must be 0");
    }
    if (params.required_review_thread_resolution !== true) {
      errors.push("pull_request.required_review_thread_resolution must be true");
    }
  }
  asserted.add("pull_request");
}

// --- required_status_checks: strict + contexts agree with config/required-checks.json in BOTH directions ---
const checksRules = findRules("required_status_checks");
if (checksRules.length === 0 || checksRules.some((r) => !r.parameters)) {
  errors.push(`missing rule: required_status_checks (policy: strict required checks matching config/required-checks.json)`);
} else {
  // `strict` is effectively OR'd across matching rules — if any applicable rule
  // sets it, the branch must be up to date live. Requiring it on every rule
  // would red a config that is genuinely strict.
  if (!checksRules.some((r) => r.parameters.strict_required_status_checks_policy === true)) {
    errors.push("required_status_checks.strict_required_status_checks_policy must be true");
  }
  // GitHub unions required contexts across every matching rule, so compare the
  // union — otherwise a context added via a second ruleset is invisible.
  const liveContexts = [
    ...new Set(
      checksRules.flatMap((rule) => (rule.parameters.required_status_checks ?? []).map((c) => c.context)),
    ),
  ];
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
  asserted.add("required_status_checks");
}

// --- non_fast_forward: force-push protection on the branch ---
const ffRules = findRules("non_fast_forward");
if (ffRules.length === 0) {
  errors.push(`missing rule: non_fast_forward (policy: no force-push to ${branch})`);
} else {
  asserted.add("non_fast_forward");
}

// --- deletion: no deleting the branch outright ---
const delRules = findRules("deletion");
if (delRules.length === 0) {
  errors.push(`missing rule: deletion (policy: no deleting ${branch})`);
} else {
  asserted.add("deletion");
}

// Self-check: every declared policy must have been reached by a live block.
// Only meaningful once the policy assertions themselves passed — on a real
// failure the specific error above is the useful one.
if (errors.length === 0) {
  for (const policy of POLICIES) {
    if (!asserted.has(policy)) {
      errors.push(
        `policy "${policy}" is declared but no assertion ran for it — this check is claiming coverage it does not have`,
      );
    }
  }
}

console.log(`read ${rules.length} rule(s) from the API; asserted ${asserted.size} of ${POLICIES.length} declared polic(y/ies): ${[...asserted].join(", ") || "(none)"}`);

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error("rules payload:", JSON.stringify(rules, null, 2));
  process.exit(1);
}
console.log(`ok: pull_request (0 reviews, resolved threads) + required_status_checks (strict, contexts match config/required-checks.json) + non_fast_forward + deletion, all present in ${rules.length} live rule(s) for ${branch}`);
console.log("required contexts:", required.join(", "));
// Name the coverage gap on every green run. A dropped assertion that prints
// nothing reads as "all clear"; this is unwatched and must say so.
console.log(
  "NOT verified live (needs Administration:read, deliberately not held): ruleset bypass_actors "
    + "(founder-team bypass); and classic branch protection's own required_status_checks copy, which "
    + "this endpoint cannot see at all, and must carry no such rule because no App can bypass it. A "
    + "re-added copy is caught by release-alarm.yml's UNALLOCATED leg within a day, not here",
);
NODE
