#!/usr/bin/env node
/**
 * Offline regression coverage for scripts/ci/assert-repo-policy.sh.
 * The script now reads GET /repos/{owner}/{repo}/rules/branches/{branch}
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
          { context: "secret scan" },
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
    {
      type: "deletion",
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
      GITHUB_REPOSITORY: "pome-sh/digital-twins",
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
    assert(r.stdout.includes("read 4 rule(s)"), r.stdout);
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
    // Missing deletion rule (branch-deletion protection) must hard-fail,
    // naming the policy — this is the red proof that the ruleset actually needs
    // the rule, not just that the script mentions it.
    const r = runAssert(baseRules().filter((rule) => rule.type !== "deletion"));
    assert(r.status === 1, "missing deletion rule must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("missing rule: deletion"), r.stderr);
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
    // Two rulesets can both match main (repo + org), so the endpoint returns a
    // rule per source. A second, laxer pull_request rule must not hide behind
    // the compliant first one.
    const rules = [
      ...baseRules(),
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 2,
          required_review_thread_resolution: true,
        },
        ruleset_source_type: "Organization",
        ruleset_source: "pome-sh",
        ruleset_id: 99999,
      },
    ];
    const r = runAssert(rules);
    assert(r.status === 1, `a second laxer pull_request rule must fail: ${r.stdout}`);
    assert(
      `${r.stdout}\n${r.stderr}`.includes("required_approving_review_count must be 0"),
      r.stderr,
    );
  }

  {
    // Same for contexts: an extra context contributed by a second
    // required_status_checks rule must be seen, not shadowed.
    const rules = [
      ...baseRules(),
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "sneaky-org-check" }],
        },
        ruleset_source_type: "Organization",
        ruleset_source: "pome-sh",
        ruleset_id: 99999,
      },
    ];
    const r = runAssert(rules);
    assert(r.status === 1, `a second rule's extra context must fail: ${r.stdout}`);
    assert(
      `${r.stdout}\n${r.stderr}`.includes(
        "has a live context absent from config/required-checks.json: sneaky-org-check",
      ),
      r.stderr,
    );
  }

  {
    // A rule type present but carrying no `parameters` at all must hard-fail,
    // not read as "nothing to assert". Every declared policy is present so the
    // only reason to red is the missing parameters — otherwise a `missing rule:`
    // error for an absent type would satisfy the exit code on its own.
    const r = runAssert([
      { type: "pull_request" },
      { type: "required_status_checks" },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ]);
    assert(r.status === 1, "rules with no parameters must fail");
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("missing rule: pull_request"), out);
    assert(out.includes("missing rule: required_status_checks"), out);
  }

  {
    // A payload that is valid JSON but not an array must hard-fail.
    const r = runAssert({ message: "Not Found" });
    assert(r.status === 1, "non-array payload must fail");
    assert(`${r.stdout}\n${r.stderr}`.includes("returned no rules"), r.stderr);
  }

  {
    // The summary count must be derived from assertions that actually ran, so
    // a declared policy with no live assertion cannot present as green. Drive
    // it through a copy of the script with the non_fast_forward block removed.
    // Pin one short line, not the whole block: this file runs inside the
    // required typecheck-test job, so a pin on six lines of source turns any
    // rename in the script into a red required check.
    const src = readFileSync(SCRIPT, "utf8");
    const marker = 'asserted.add("non_fast_forward");';
    assert(src.includes(marker), `${marker} not found in the script — update this test`);
    // Mutant lives in the temp dir, never in the repo tree: a crash between
    // write and cleanup must not leave a policy script with an assertion
    // removed sitting in scripts/ci/ ready to be committed. The script derives
    // REPO_ROOT from its own path, so hand it the config explicitly.
    const dir = mkdtempSync(join(tmpdir(), "assert-policy-selfcheck-"));
    const mutant = join(dir, "assert-repo-policy.mutant.sh");
    const rulesPath = join(dir, "rules.json");
    writeFileSync(rulesPath, JSON.stringify(baseRules()));
    writeFileSync(mutant, src.replace(marker, "/* assertion removed */"));
    const r = spawnSync("bash", [mutant], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "pome-sh/digital-twins",
        RULES_JSON: rulesPath,
        REQUIRED_CHECKS_FILE: join(ROOT, "config/required-checks.json"),
      },
    });
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 1, `dropping an assertion block must fail, got ${r.status}: ${r.stdout}`);
    assert(
      `${r.stdout}\n${r.stderr}`.includes('policy "non_fast_forward" is declared but no assertion ran'),
      `${r.stdout}\n${r.stderr}`,
    );
  }

  {
    // Green runs must name what is NOT watched live, so a reader is never
    // told coverage is total. Deletion is now asserted live (the
    // ruleset carries the rule), so bypass_actors is the only named gap and
    // the NOT-verified line must no longer mention deletion.
    const r = runAssert(baseRules());
    assert(r.stdout.includes("NOT verified live"), r.stdout);
    assert(r.stdout.includes("bypass_actors"), r.stdout);
    const notVerifiedLine = r.stdout.split("\n").find((l) => l.includes("NOT verified live"));
    assert(notVerifiedLine && !notVerifiedLine.includes("deletion"), r.stdout);
  }

  {
    const y = readFileSync(join(ROOT, ".github/workflows/repo-policy.yml"), "utf8");
    // The fixture seam must never be reachable in CI: an env var that stubs
    // the API is a way to make a live check pass without calling anything.
    assert(
      !/RULES_JSON/.test(y),
      "repo-policy.yml must never set RULES_JSON — that would stub out the live API call",
    );
    assert(!/administration:\s*read/.test(y), "GITHUB_TOKEN cannot use administration scope");
    assert(
      !/secrets\.REPO_POLICY_TOKEN/.test(y),
      "repo-policy must not read the REPO_POLICY_TOKEN secret anymore",
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
    // Match the request URL, not `api -o.*<path>`: the legacy calls wrapped the
    // URL onto its own line, so a `.`-based pattern without /s never saw them
    // and this guard passed on exactly the code it exists to forbid. Anchoring
    // on api.github.com also keeps prose in the header comments from tripping it.
    assert(
      !/api\.github\.com\/[^"'\s]*\/rulesets/.test(scriptSrc),
      "assert-repo-policy.sh must not call the legacy admin-scoped .../rulesets endpoint",
    );
    assert(
      !/api\.github\.com\/[^"'\s]*\/protection/.test(scriptSrc),
      "assert-repo-policy.sh must not call the legacy admin-scoped .../protection endpoint",
    );
    // Guard the guard: prove the patterns above fire on the multi-line shape the
    // removed code actually used, so they cannot rot back into always-true.
    const legacyShape = [
      'code="$(api -o "${LIST_OUT}" -w \'%{http_code}\' \\',
      '  "https://api.github.com/repos/${REPO}/rulesets")"',
      'code="$(api -o "${OUT}" -w \'%{http_code}\' \\',
      '  "https://api.github.com/repos/${REPO}/branches/${BRANCH}/protection")"',
    ].join("\n");
    assert(
      /api\.github\.com\/[^"'\s]*\/rulesets/.test(legacyShape) &&
        /api\.github\.com\/[^"'\s]*\/protection/.test(legacyShape),
      "the legacy-endpoint guards no longer match the code they exist to forbid",
    );
  }

  console.log("✅ assert-repo-policy regression tests passed");
}

main();
