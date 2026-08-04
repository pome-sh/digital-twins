#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1180 — make an unmergeable CLI release visible.
//
// Nothing in this repo reported that `@pome-sh/cli` had shipped changesets
// sitting behind a version PR that could never merge. The PR was open, green-ish
// looking, and simply collected no checks; the only reason anyone found out was
// a human trying to merge it. A release that is stuck reads exactly like a
// release nobody has got round to — so this runs on its own daily schedule and
// files an issue when the two stop being the same thing.
//
// Deliberately a SEPARATE workflow from cli-release.yml, on its own trigger, for
// the reason check-specs-staleness.yml gives: a check embedded in the workflow
// it is watching disappears when that workflow does.
//
// What it alarms on:
//
//   BLOCKED   — an open `changeset-release/main` PR whose head commit will not
//               produce main's required contexts (parked at `action_required`,
//               or never started). This is F-1180 itself, caught from outside.
//   STALE     — an open release PR older than MAX_AGE_DAYS. Covers every other
//               way a release stalls: unresolved conversations, a red check, a
//               human who forgot.
//   NO_RELEASE — changesets are pending on main and the last `cli-release` run
//               failed, so no version PR is coming. A run that *skipped*
//               (`ready=false`, waiting on the packages-v* batch) concludes
//               success and is deliberately NOT an alarm — that wait is the
//               designed ordering and can legitimately last days.
//
// Usage: node scripts/ci/check-release-staleness.mjs [repo root]
//   env: GITHUB_REPOSITORY, GH_TOKEN, MAX_AGE_DAYS (default 3), NOW_MS (tests)
//   Writes stale= / reason= / report= to $GITHUB_OUTPUT. Exits 1 when stale.

import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classify, readRequiredContexts } from "./verify-release-pr-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_BRANCH = "changeset-release/main";

/** Changeset files awaiting a release — `README.md` and `config.json` are not. */
export function pendingChangesets(root) {
  const dir = join(root, "cli/.changeset");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function main() {
  const root = resolve(process.argv[2] ?? join(HERE, "../.."));
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const maxAgeDays = Number(process.env.MAX_AGE_DAYS ?? 3);
  const now = Number(process.env.NOW_MS ?? Date.now());
  const contexts = readRequiredContexts(root);

  const pending = pendingChangesets(root);
  const lines = [`pending changesets on main: ${pending.length}${pending.length ? ` (${pending.join(", ")})` : ""}`];

  const prs = JSON.parse(
    gh([
      "api",
      `repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${RELEASE_BRANCH}&per_page=10`,
    ]) || "[]",
  );
  const pr = prs[0];

  let reason = "";
  if (pr) {
    const ageDays = (now - Date.parse(pr.created_at)) / 86_400_000;
    lines.push(`release PR: #${pr.number} "${pr.title}" — ${ageDays.toFixed(1)}d old, head ${pr.head.sha}`);

    const payload = JSON.parse(
      gh(["api", `repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`]) || "{}",
    );
    const state = classify(payload.check_runs, contexts);
    lines.push(`  reporting: ${state.reporting.join(", ") || "(none)"}`);
    lines.push(`  parked at action_required: ${state.parked.join(", ") || "(none)"}`);
    lines.push(`  never started: ${state.missing.join(", ") || "(none)"}`);

    if (!state.ok) {
      reason = `BLOCKED — release PR #${pr.number} cannot merge: ${[
        state.parked.length ? `${state.parked.length} required context(s) parked at action_required` : "",
        state.missing.length ? `${state.missing.length} never started` : "",
      ]
        .filter(Boolean)
        .join("; ")}`;
    } else if (ageDays > maxAgeDays) {
      reason = `STALE — release PR #${pr.number} has been open ${ageDays.toFixed(1)} days (limit ${maxAgeDays}) with its checks reporting`;
    }
  } else if (pending.length > 0) {
    lines.push("release PR: none open");
    // Deliberately a WINDOW of runs, not `per_page=1`. cli-release declares
    // `cancel-in-progress: false`, so a hung run keeps holding the concurrency
    // lock while a later `cli/**` push queues a fresh run behind it. Reading
    // only the newest run sees that queued run's brand-new `created_at` and
    // calls the release path healthy while nothing can actually proceed.
    const runs = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/workflows/cli-release.yml/runs?branch=main&per_page=10`,
      ]) || "{}",
    );
    const all = runs.workflow_runs ?? [];
    const ageOf = (run) => (now - Date.parse(run.created_at)) / 86_400_000;
    const inFlight = all.filter((r) => !r.conclusion);
    const stuck = inFlight.filter((r) => ageOf(r) > maxAgeDays);
    const newestDone = all.find((r) => r.conclusion);

    lines.push(
      `cli-release runs (newest ${all.length}): ` +
        (all.map((r) => `${r.conclusion ?? r.status}@${ageOf(r).toFixed(1)}d`).join(", ") || "none"),
    );

    if (all.length === 0) {
      reason = `NO_RELEASE — ${pending.length} changeset(s) are pending and cli-release has never run on main, so no version PR is coming`;
    } else if (stuck.length > 0) {
      reason = `NO_RELEASE — ${pending.length} changeset(s) are pending and a cli-release run has been ${stuck[0].status} for ${ageOf(stuck[0]).toFixed(1)} days (limit ${maxAgeDays}); with cancel-in-progress:false it is holding the concurrency lock, so queued runs behind it cannot release either`;
    } else if (inFlight.length > 0) {
      // Something is actively running and has not been running too long. That
      // is the release path working, whatever the older runs say.
      lines.push("a cli-release run is in flight and not overdue — not alarming");
    } else if (newestDone.conclusion !== "success") {
      reason = `NO_RELEASE — ${pending.length} changeset(s) are pending and the last cli-release run concluded ${newestDone.conclusion}, so no version PR is coming`;
    } else if (ageOf(newestDone) > maxAgeDays) {
      // A skipped-but-successful run is the designed packages-v* wait — but
      // only for as long as the batch actually takes. Past the window the
      // tolerance becomes the bug: cli-release only fires on a push touching
      // `cli/**`, so if the batch publishes and nobody pushes again, the run
      // that skipped stays the newest run FOREVER, concluded `success`, and
      // "still waiting" is indistinguishable from "nothing is ever coming".
      // That is this ticket's own defect wearing a different hat.
      reason = `NO_RELEASE — ${pending.length} changeset(s) have been pending with no release PR and no cli-release run for ${ageOf(newestDone).toFixed(1)} days (limit ${maxAgeDays}); the last run concluded ${newestDone.conclusion}`;
    }
  } else {
    lines.push("release PR: none open; nothing pending");
  }

  const report = lines.join("\n");
  console.log(report);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `stale=${reason ? "true" : "false"}\nreason=${reason}\nreport<<POME_EOF\n${report}\nPOME_EOF\n`,
    );
  }

  if (reason) {
    console.error(`::error::${reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ CLI release path is not stuck.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
