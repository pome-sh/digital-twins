#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for scripts/ci/verify-release-pr-checks.mjs (F-1180).
 *
 * Mocks `gh` on PATH — no GitHub calls. The cases that matter:
 *
 *   - A head commit whose check runs all sit at `action_required` must NOT be
 *     read as ready. This is the exact shape the F-1115 prior art gets wrong:
 *     it tests `check-runs.total_count > 0`, and a parked run is a check run.
 *     Case 2 asserts a non-zero count with every context parked still
 *     remediates, which is the whole ticket in one assertion.
 *   - Zero check runs (the other GITHUB_TOKEN suppression shape) is also not
 *     ready.
 *   - The escalation ladder actually escalates: approve, then close/reopen with
 *     the bot token, then a loud non-zero exit. The last one is what stops this
 *     rotting back into "nothing happened, looks fine".
 *   - cli-release.yml really wires the script up, and really passes a
 *     non-ambient token. A verifier nothing calls is the same silence.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/verify-release-pr-checks.mjs");
const CONTEXTS = JSON.parse(
  readFileSync(join(ROOT, "config/required-checks.json"), "utf8"),
).contexts;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Check runs for every required context, all with the given conclusion. */
function checkRuns(conclusion, contexts = CONTEXTS) {
  return contexts.map((name, i) => ({
    id: 100 + i,
    name,
    status: "completed",
    conclusion,
  }));
}

const GH_IMPL = `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(join(here, "state.json"), "utf8"));
const phaseFile = join(here, "phase");
const phase = existsSync(phaseFile) ? Number(readFileSync(phaseFile, "utf8")) : 0;
const advance = () => writeFileSync(phaseFile, String(Math.min(phase + 1, state.phases.length - 1)));
const args = process.argv.slice(2);
const joined = args.join(" ");

if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(state.headSha + "\\n");
} else if (joined.includes("/check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: state.phases[phase].checkRuns }));
} else if (joined.includes("/actions/runs?head_sha")) {
  process.stdout.write(JSON.stringify({ workflow_runs: state.phases[phase].runs ?? [] }));
} else if (joined.includes("/approve")) {
  if (state.approveFails) {
    process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n");
    process.exit(1);
  }
  if (state.advanceOn === "approve") advance();
} else if (args[0] === "pr" && args[1] === "reopen") {
  if (state.advanceOn === "reopen") advance();
} else if (args[0] === "pr" && args[1] === "close") {
  // no-op
} else {
  process.stderr.write("unexpected gh call: " + joined + "\\n");
  process.exit(2);
}
`;

function run(state, { botToken = "", prNumber = "281" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "gh-impl.mjs"), GH_IMPL);
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$(dirname "$0")/calls.log"
exec node "$(dirname "$0")/gh-impl.mjs" "$@"
`,
  );
  chmodSync(join(dir, "gh"), 0o755);

  const result = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "pome-sh/digital-twins",
      GH_TOKEN: "ambient-token",
      RELEASE_BOT_TOKEN: botToken,
      PR_NUMBER: prNumber,
      VERIFY_INTERVAL_S: "0",
      VERIFY_TIMEOUT_S: "0",
    },
  });
  const logPath = join(dir, "calls.log");
  const calls = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, out: `${result.stdout}\n${result.stderr}` };
}

function main() {
  // 1 — everything already reporting: exit 0, and no remediation attempted.
  {
    const r = run({
      headSha: "abc123",
      phases: [{ checkRuns: checkRuns("success") }],
    });
    assert(r.status === 0, `expected clean pass, got ${r.status}: ${r.out}`);
    assert(!r.calls.includes("approve"), `must not approve a healthy PR: ${r.calls}`);
    assert(!r.calls.includes("pr close"), `must not close a healthy PR: ${r.calls}`);
  }

  // 2 — THE TICKET. Check runs exist (total_count > 0, so the prior art's test
  // would call this ready) but every one is parked. Approving unblocks it.
  {
    const parked = checkRuns("action_required");
    const r = run({
      headSha: "abc123",
      advanceOn: "approve",
      phases: [
        { checkRuns: parked, runs: [{ id: 9001, conclusion: "action_required" }] },
        { checkRuns: checkRuns("success") },
      ],
    });
    assert(r.status === 0, `expected approve to unblock, got ${r.status}: ${r.out}`);
    assert(r.calls.includes("runs/9001/approve"), `must approve the parked run: ${r.calls}`);
    assert(parked.length > 0, "fixture sanity: the head commit does have check runs");
  }

  // 3 — approve refused (the ambient token's 403). With a bot token, escalate
  // to close/reopen, which retriggers as a real actor.
  {
    const r = run(
      {
        headSha: "abc123",
        approveFails: true,
        advanceOn: "reopen",
        phases: [
          {
            checkRuns: checkRuns("action_required"),
            runs: [{ id: 9002, conclusion: "action_required" }],
          },
          { checkRuns: checkRuns("success") },
        ],
      },
      { botToken: "pat-xxx" },
    );
    assert(r.status === 0, `expected close/reopen to unblock, got ${r.status}: ${r.out}`);
    assert(r.calls.includes("pr close 281"), `must close: ${r.calls}`);
    assert(r.calls.includes("pr reopen 281"), `must reopen: ${r.calls}`);
  }

  // 4 — nothing works and there is no bot token: fail LOUDLY and name the fix.
  // Exiting 0 here is the defect this ticket exists for.
  {
    const r = run({
      headSha: "abc123",
      approveFails: true,
      phases: [
        {
          checkRuns: checkRuns("action_required"),
          runs: [{ id: 9003, conclusion: "action_required" }],
        },
      ],
    });
    assert(r.status === 1, `expected loud failure, got ${r.status}: ${r.out}`);
    assert(r.out.includes("::error::"), `must emit a workflow error: ${r.out}`);
    assert(r.out.includes("RELEASE_BOT_TOKEN"), `must name the durable fix: ${r.out}`);
    assert(!r.calls.includes("pr close"), `close/reopen is pointless without a PAT: ${r.calls}`);
  }

  // 5 — the other suppression shape: zero check runs at all.
  {
    const r = run({
      headSha: "abc123",
      approveFails: true,
      phases: [{ checkRuns: [], runs: [] }],
    });
    assert(r.status === 1, `zero check runs must not read as ready, got ${r.status}: ${r.out}`);
    assert(r.out.includes("never started"), r.out);
  }

  // 6 — partial: two contexts report, one never started. Still not mergeable.
  {
    const partial = checkRuns("success", CONTEXTS.slice(0, CONTEXTS.length - 1));
    const r = run({
      headSha: "abc123",
      approveFails: true,
      phases: [{ checkRuns: partial, runs: [] }],
    });
    assert(r.status === 1, `a missing context must block, got ${r.status}: ${r.out}`);
    assert(r.out.includes(CONTEXTS[CONTEXTS.length - 1]), `must name the missing context: ${r.out}`);
  }

  // 7 — a queued run has not reported yet but will; that is not a park.
  {
    const queued = CONTEXTS.map((name, i) => ({
      id: 200 + i,
      name,
      status: "in_progress",
      conclusion: null,
    }));
    const r = run({ headSha: "abc123", phases: [{ checkRuns: queued }] });
    assert(r.status === 0, `in-progress checks are reporting, got ${r.status}: ${r.out}`);
  }

  // 8 — no PR opened (the changesets step published instead): clean no-op.
  {
    const r = run({ headSha: "abc123", phases: [{ checkRuns: [] }] }, { prNumber: "" });
    assert(r.status === 0, `no PR must be a clean no-op, got ${r.status}: ${r.out}`);
    assert(r.stdout.includes("No release PR"), r.stdout);
  }

  // 9 — the wiring. A verifier nothing calls is the same silence as no verifier.
  {
    const y = readFileSync(join(ROOT, ".github/workflows/cli-release.yml"), "utf8");
    assert(
      /verify-release-pr-checks\.mjs/.test(y),
      "cli-release.yml must run scripts/ci/verify-release-pr-checks.mjs",
    );
    assert(
      /RELEASE_BOT_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN/.test(y.replace(/\$\{\{|\}\}/g, "")),
      "cli-release.yml must prefer RELEASE_BOT_TOKEN over the ambient GITHUB_TOKEN when opening the PR",
    );
    assert(/actions:\s*write/.test(y), "cli-release.yml needs actions:write to approve parked runs");
  }

  // 10 — the required-context list has exactly one home.
  {
    const policy = readFileSync(join(ROOT, "scripts/ci/assert-repo-policy.sh"), "utf8");
    assert(
      /config\/required-checks\.json/.test(policy),
      "assert-repo-policy.sh must read config/required-checks.json, not carry its own copy",
    );
    assert(
      !/"gitleaks \+ trufflehog"/.test(policy),
      "assert-repo-policy.sh must not hardcode required contexts (F-1135: no second copy)",
    );
  }

  console.log("✅ verify-release-pr-checks regression tests passed");
}

main();
