#!/usr/bin/env node
/**
 * Offline regression coverage for scripts/ci/assert-repo-policy.sh (F-696).
 * F-1212 — the script now reads GET /repos/{owner}/{repo}/rules/branches/{branch}
 * (metadata-scoped GITHUB_TOKEN, no PAT) instead of the legacy admin-scoped
 * .../protection + .../rulesets pair. Feeds fixture rules JSON (no live API).
 *
 * The property under test isn't just "correct config passes" — it's that a
 * rules response which stops COVERING a policy (missing rule type, empty
 * array) is a hard failure, never a silent pass.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/assert-repo-policy.sh");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function baseRules(overrides = {}) {
  const rules = [
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        required_review_thread_resolution: true,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
      },
      ruleset_source_type: "Repository",
      ruleset_source: "pome-sh/pome-twins",
      ruleset_id: 18797095,
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: "typecheck-test" },
          { context: "gitleaks + trufflehog" },
          { context: "dependency review" },
        ],
      },
      ruleset_source_type: "Repository",
      ruleset_source: "pome-sh/pome-twins",
      ruleset_id: 18797095,
    },
    {
      type: "non_fast_forward",
      ruleset_source_type: "Repository",
      ruleset_source: "pome-sh/pome-twins",
      ruleset_id: 18797095,
    },
  ];
  return overrides.rules !== undefined ? overrides.rules : rules;
}

function runAssert(rules) {
  const dir = mkdtempSync(join(tmpdir(), "assert-policy-"));
  const rulesPath = join(dir, "rules.json");
  writeFileSync(rulesPath, JSON.stringify(rules));
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "pome-sh/pome-twins",
      RULES_JSON: rulesPath,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

function main() {
  {
    const r = runAssert(baseRules());
    assert(r.status === 0, `expected ok fixture to pass: ${r.stderr}\n${r.stdout}`);
    assert(r.stdout.includes("ok:"), r.stdout);
    assert(r.stdout.includes("read 3 rule(s)"), r.stdout);
  }

  {
    // Empty response must hard-fail, never "nothing to check".
    const r = runAssert([]);
    assert(r.status === 1, "empty rules array must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("returned no rules"), r.stderr);
  }

  {
    // Missing required_status_checks rule entirely (e.g. dropped by the API,
    // or protection moved elsewhere) must hard-fail, naming the policy.
    const r = runAssert(baseRules().filter((rule) => rule.type !== "required_status_checks"));
    assert(r.status === 1, "missing required_status_checks rule must fail");
    assert(
      `${r.stdout}\n${r.stderr}`.includes("missing rule: required_status_checks"),
      r.stderr,
    );
  }

  {
    // Missing non_fast_forward rule (force-push protection) must hard-fail.
    const r = runAssert(baseRules().filter((rule) => rule.type !== "non_fast_forward"));
    assert(r.status === 1, "missing non_fast_forward rule must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("missing rule: non_fast_forward"), r.stderr);
  }

  {
    // Missing pull_request rule must hard-fail.
    const r = runAssert(baseRules().filter((rule) => rule.type !== "pull_request"));
    assert(r.status === 1, "missing pull_request rule must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("missing rule: pull_request"), r.stderr);
  }

  {
    const rules = baseRules().map((rule) =>
      rule.type === "required_status_checks"
        ? { ...rule, parameters: { ...rule.parameters, strict_required_status_checks_policy: false } }
        : rule,
    );
    const r = runAssert(rules);
    assert(r.status === 1, "strict_required_status_checks_policy:false must fail");
    assert(
      `${r.stdout}\n${r.stderr}`.includes("strict_required_status_checks_policy must be true"),
      r.stderr,
    );
  }

  {
    // Context present in the ruleset but absent from config/required-checks.json.
    const rules = baseRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: [
                ...rule.parameters.required_status_checks,
                { context: "extra-check-not-in-config" },
              ],
            },
          }
        : rule,
    );
    const r = runAssert(rules);
    assert(r.status === 1, "live context absent from config must fail");
    assert(
      `${r.stdout}\n${r.stderr}`.includes(
        "has a live context absent from config/required-checks.json: extra-check-not-in-config",
      ),
      r.stderr,
    );
  }

  {
    // Context present in config/required-checks.json but absent from the ruleset.
    const rules = baseRules().map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: rule.parameters.required_status_checks.filter(
                (c) => c.context !== "dependency review",
              ),
            },
          }
        : rule,
    );
    const r = runAssert(rules);
    assert(r.status === 1, "config context missing from ruleset must fail");
    assert(
      `${r.stdout}\n${r.stderr}`.includes(
        "missing context present in config/required-checks.json: dependency review",
      ),
      r.stderr,
    );
  }

  {
    const rules = baseRules().map((rule) =>
      rule.type === "pull_request"
        ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 1 } }
        : rule,
    );
    const r = runAssert(rules);
    assert(r.status === 1, "non-zero approving reviews must fail");
    assert(
      `${r.stdout}\n${r.stderr}`.includes("required_approving_review_count must be 0"),
      r.stderr,
    );
  }

  {
    const rules = baseRules().map((rule) =>
      rule.type === "pull_request"
        ? { ...rule, parameters: { ...rule.parameters, required_review_thread_resolution: false } }
        : rule,
    );
    const r = runAssert(rules);
    assert(r.status === 1, "disabled conversation resolution must fail");
    assert(
      `${r.stdout}\n${r.stderr}`.includes("required_review_thread_resolution must be true"),
      r.stderr,
    );
  }

  {
    const y = readFileSync(join(ROOT, ".github/workflows/repo-policy.yml"), "utf8");
    assert(!/administration:\s*read/.test(y), "GITHUB_TOKEN cannot use administration scope");
    assert(
      !/secrets\.REPO_POLICY_TOKEN/.test(y),
      "repo-policy must not read the REPO_POLICY_TOKEN secret anymore (F-1212)",
    );
    assert(
      /assert-repo-policy\.test\.mjs/.test(y),
      "repo-policy must run offline validator tests",
    );
    const liveStep = y.match(/- name: Assert live branch protection([\s\S]*?)(?=\n {2}- name:|\n {2,4}[a-z-]+:\n|$)/);
    assert(liveStep, "repo-policy must contain the live protection step");
    assert(
      /secrets\.GITHUB_TOKEN/.test(liveStep[1]),
      "live protection step must use the ordinary GITHUB_TOKEN, not a PAT",
    );
  }

  {
    const scriptSrc = readFileSync(SCRIPT, "utf8");
    assert(
      /api -o.*rules\/branches\/\$\{BRANCH\}/s.test(scriptSrc),
      "assert-repo-policy.sh must call GET .../rules/branches/{branch}",
    );
    assert(
      !/api -o.*\/rulesets/.test(scriptSrc) && !/api -o.*\/protection/.test(scriptSrc),
      "assert-repo-policy.sh must not call the legacy admin-scoped endpoints",
    );
  }

  console.log("✅ assert-repo-policy regression tests passed");
}

main();
