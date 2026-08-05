#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1180 — the Changesets release PR must actually collect its required checks.
//
// THE DEFECT. `cli-release.yml` opens `chore(cli): version packages` on
// `changeset-release/main` using the ambient `GITHUB_TOKEN`. Every workflow run
// on that branch whose `triggering_actor` is `github-actions[bot]` concludes
// `action_required` — GitHub's manual-approval park, 0s duration, no status
// reported. `main` requires three contexts, so they sit in `expected` forever
// and the PR can never merge:
//
//     GraphQL: Repository rule violations found
//     3 of 3 required status checks are expected.
//
// `gh pr merge --admin` does NOT rescue this. A context that is *expected but
// absent* is a different rule violation from one that failed, and admin merge
// overrides only the latter. (It did work on a neighbouring PR the same day —
// there the checks had run and only the strict/up-to-date rule was blocking.)
//
// WHY IT LOOKED LIKE IT USED TO WORK. It never did. 278 runs on
// `changeset-release/main` split perfectly on `triggering_actor`: bot-triggered
// runs park, human-triggered runs succeed. Every release so far had a human
// touch the branch afterwards (the "push an empty commit" habit), and that
// human-triggered run satisfied the contexts while the bot's parked runs sat
// there ignored. The first release that skipped the folklore step deadlocked.
//
// WHAT IT IS NOT — and this is the correction worth recording, because the
// obvious diagnosis is wrong. It is NOT the repository's fork-PR
// contributor-approval policy (`approval_policy: first_time_contributors`).
// `renovate[bot]` opens PRs on same-repo branches in this repo under that
// exact setting and its runs go green. Only `github-actions[bot]` parks. So
// loosening a repo setting fixes nothing; the
// axis is the token. This is GitHub's anti-recursion guard — deliberate design,
// not a bug — and the only durable fix is to stop using the ambient token to
// push the release branch. `RELEASE_BOT_TOKEN` (a PAT, the `SPECS_BOT_TOKEN`
// equivalent from F-1115 in `pome-sh/openapi-spec-mcp`) is a real actor as far
// as GitHub's trigger logic is concerned.
//
// WHY NOT JUST COUNT CHECK RUNS. The F-1115 prior art tests
// `check-runs.total_count > 0` on the head commit. That test is GREEN HERE AND
// WRONG: parked runs *do* create check runs, they just conclude
// `action_required`. Reuse of that shape would have reported "ready" on a PR
// that can never merge — the thirteenth instance in this project of a signal
// that never reported reading exactly like one that passed. This script
// classifies every required context as reporting / parked / missing.
//
// ESCALATION LADDER, loudest-last:
//   1. Poll. If every required context reports, exit 0.
//   2. Approve the parked runs (`POST .../actions/runs/{id}/approve`). This is
//      the deterministic unblock observed live on 2026-08-03 and needs no push.
//      The ambient token may be refused here (403) — that is expected, not a
//      failure, so a refusal falls through rather than exiting.
//   3. Close and reopen the PR with `RELEASE_BOT_TOKEN`. A PAT action re-fires
//      `pull_request` (default types include `reopened`) as a real actor.
//      Skipped when only the ambient token is available, because closing and
//      reopening with it reproduces the same parked runs.
//   4. Fail loudly with the exact manual unblock. NEVER exit 0 on a PR whose
//      contexts are absent: that is the failure mode this ticket is about.
//
// Usage: node scripts/ci/verify-release-pr-checks.mjs
//   env: GITHUB_REPOSITORY, PR_NUMBER, GH_TOKEN,
//        RELEASE_BOT_TOKEN (optional — enables step 3),
//        VERIFY_INTERVAL_S (default 15), VERIFY_TIMEOUT_S (default 240)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The contexts `main` requires, read from the one file that holds them. */
export function readRequiredContexts(root = ROOT) {
  const cfg = JSON.parse(readFileSync(join(root, "config/required-checks.json"), "utf8"));
  if (!Array.isArray(cfg.contexts) || cfg.contexts.length === 0) {
    throw new Error("config/required-checks.json must list a non-empty `contexts` array");
  }
  return cfg.contexts;
}

/**
 * Split the required contexts by whether they are actually going to report.
 *
 * `action_required` is the whole point: it is a *completed* check run carrying
 * no status, so anything that only asks "does a check run exist" calls it ready.
 * A queued or in-progress run is fine — it has not reported yet, but it will.
 */
export function classify(checkRuns, contexts) {
  const newest = new Map();
  for (const run of checkRuns ?? []) {
    const prev = newest.get(run.name);
    if (!prev || Number(run.id) > Number(prev.id)) newest.set(run.name, run);
  }

  const reporting = [];
  const parked = [];
  const missing = [];
  for (const ctx of contexts) {
    const run = newest.get(ctx);
    if (!run) missing.push(ctx);
    else if (run.conclusion === "action_required") parked.push(ctx);
    else reporting.push(ctx);
  }
  return { reporting, parked, missing, ok: parked.length === 0 && missing.length === 0 };
}

/** Workflow-run ids parked at `action_required` — the things step 2 approves. */
export function parkedRunIds(workflowRuns) {
  return (workflowRuns ?? [])
    .filter((run) => run.conclusion === "action_required")
    .map((run) => run.id);
}

function gh(args, { token, allowFailure = false } = {}) {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_TOKEN: token || process.env.GH_TOKEN || "" },
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const stderr = String(err.stderr ?? "") || String(err.message ?? "");
    if (allowFailure) return { ok: false, stdout: "", stderr };
    throw new Error(`gh ${args.join(" ")} failed:\n${stderr.trim()}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = (process.env.PR_NUMBER ?? "").trim();
  const botToken = process.env.RELEASE_BOT_TOKEN ?? "";
  const contexts = readRequiredContexts();
  const intervalMs = Number(process.env.VERIFY_INTERVAL_S ?? 15) * 1000;
  const timeoutMs = Number(process.env.VERIFY_TIMEOUT_S ?? 240) * 1000;

  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  // No PR number means the changesets step published instead of opening one —
  // there is nothing to verify, and saying so beats an empty success.
  if (!prNumber) {
    console.log("No release PR was opened by this run (nothing to verify).");
    return;
  }

  const headSha = gh([
    "pr",
    "view",
    prNumber,
    "--repo",
    repo,
    "--json",
    "headRefOid",
    "--jq",
    ".headRefOid",
  ]).stdout.trim();
  console.log(`Release PR #${prNumber} head commit: ${headSha}`);

  /** Poll until every required context reports, or the deadline passes. */
  async function settle() {
    const deadline = Date.now() + timeoutMs;
    let state;
    for (;;) {
      const payload = JSON.parse(
        gh(["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`]).stdout || "{}",
      );
      state = classify(payload.check_runs, contexts);
      if (state.ok || Date.now() >= deadline) return state;
      console.log(
        `waiting — reporting: ${state.reporting.length}/${contexts.length}` +
          `${state.parked.length ? `, parked: ${state.parked.join(", ")}` : ""}` +
          `${state.missing.length ? `, missing: ${state.missing.join(", ")}` : ""}`,
      );
      await sleep(intervalMs);
    }
  }

  function describe(state) {
    return [
      `  reporting: ${state.reporting.join(", ") || "(none)"}`,
      `  parked at action_required: ${state.parked.join(", ") || "(none)"}`,
      `  never started: ${state.missing.join(", ") || "(none)"}`,
    ].join("\n");
  }

  let state = await settle();
  if (state.ok) {
    console.log(`✅ All ${contexts.length} required contexts are reporting on ${headSha}.`);
    return;
  }
  console.log(`Required contexts are not all reporting:\n${describe(state)}`);

  // Step 2 — approve whatever is parked. Deterministic when the token is
  // allowed to do it; a 403 from the ambient token is an expected outcome here,
  // so it falls through to step 3 instead of failing the run.
  const runs = JSON.parse(
    gh(["api", `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`]).stdout || "{}",
  );
  const ids = parkedRunIds(runs.workflow_runs);
  if (ids.length > 0) {
    let approved = 0;
    for (const id of ids) {
      const res = gh(["api", "-X", "POST", `repos/${repo}/actions/runs/${id}/approve`], {
        allowFailure: true,
      });
      if (res.ok) approved++;
      else console.log(`could not approve run ${id}: ${res.stderr.trim().split("\n")[0]}`);
    }
    console.log(`Approved ${approved}/${ids.length} parked workflow run(s).`);
    if (approved > 0) {
      state = await settle();
      if (state.ok) {
        console.log(`✅ All required contexts report after approving parked runs.`);
        return;
      }
    }
  }

  // Step 3 — close/reopen as a real actor. Pointless with the ambient token:
  // the reopened run would carry the same triggering_actor and park again.
  if (botToken) {
    console.log(`Closing and reopening PR #${prNumber} with RELEASE_BOT_TOKEN to retrigger CI.`);
    gh(["pr", "close", prNumber, "--repo", repo], { token: botToken });
    gh(["pr", "reopen", prNumber, "--repo", repo], { token: botToken });
    state = await settle();
    if (state.ok) {
      console.log(`✅ All required contexts report after the close/reopen retrigger.`);
      return;
    }
  }

  // Step 4 — never silence.
  const remedy = botToken
    ? `RELEASE_BOT_TOKEN is configured but the checks still are not reporting. Inspect the runs on ${headSha} directly.`
    : `RELEASE_BOT_TOKEN is NOT configured, so this PR was opened by the ambient GITHUB_TOKEN and its workflow runs park at action_required by design. Mint a PAT with contents+pull-requests write and add it as the repo secret RELEASE_BOT_TOKEN — that is the durable fix (see this script's header for why the repo Actions setting is not).`;
  console.error(`::error::Release PR #${prNumber} cannot merge — its required checks will never report.
${describe(state)}

${remedy}

Manual unblock for this PR:
  for id in $(gh run list --branch changeset-release/main --json databaseId,conclusion \\
                --jq '.[] | select(.conclusion=="action_required") | .databaseId'); do
    gh api -X POST repos/${repo}/actions/runs/$id/approve
  done`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
