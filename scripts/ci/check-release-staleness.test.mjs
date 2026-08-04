#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for scripts/ci/check-release-staleness.mjs (F-1180).
 *
 * Mocks `gh` on PATH. The alarm's value is entirely in what it does NOT fire
 * on: a release PR waiting on the packages-v* batch is the designed ordering,
 * and an alarm that cries wolf there gets muted, at which point the real
 * BLOCKED case is invisible again. So both directions are asserted.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/check-release-staleness.mjs");
const CONTEXTS = JSON.parse(
  readFileSync(join(ROOT, "config/required-checks.json"), "utf8"),
).contexts;

const NOW_MS = Date.parse("2026-08-04T12:00:00Z");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function checkRuns(conclusion) {
  return CONTEXTS.map((name, i) => ({ id: 300 + i, name, status: "completed", conclusion }));
}

const GH_IMPL = `
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(join(here, "state.json"), "utf8"));
const joined = process.argv.slice(2).join(" ");

if (joined.includes("/pulls?state=open")) {
  process.stdout.write(JSON.stringify(state.pulls ?? []));
} else if (joined.includes("/check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: state.checkRuns ?? [] }));
} else if (joined.includes("cli-release.yml/runs")) {
  process.stdout.write(JSON.stringify({ workflow_runs: state.releaseRuns ?? [] }));
} else {
  process.stderr.write("unexpected gh call: " + joined + "\\n");
  process.exit(2);
}
`;

/** @param changesets file names to place under cli/.changeset/ */
function run(state, changesets = []) {
  const dir = mkdtempSync(join(tmpdir(), "release-stale-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "gh-impl.mjs"), GH_IMPL);
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash\nexec node "$(dirname "$0")/gh-impl.mjs" "$@"\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);

  // A fixture repo root: config/ is read for the contexts, cli/.changeset/ for
  // what is pending.
  const fixture = mkdtempSync(join(tmpdir(), "release-root-"));
  mkdirSync(join(fixture, "config"), { recursive: true });
  writeFileSync(
    join(fixture, "config/required-checks.json"),
    readFileSync(join(ROOT, "config/required-checks.json")),
  );
  mkdirSync(join(fixture, "cli/.changeset"), { recursive: true });
  writeFileSync(join(fixture, "cli/.changeset/README.md"), "not a changeset\n");
  for (const name of changesets) writeFileSync(join(fixture, "cli/.changeset", name), "---\n");

  const result = spawnSync("node", [SCRIPT, fixture], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "pome-sh/digital-twins",
      GH_TOKEN: "t",
      MAX_AGE_DAYS: "3",
      NOW_MS: String(NOW_MS),
    },
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
  return { ...result, out: `${result.stdout}\n${result.stderr}` };
}

function openPr(createdAt) {
  return [
    {
      number: 281,
      title: "chore(cli): version packages",
      created_at: createdAt,
      head: { sha: "abc123" },
    },
  ];
}

function main() {
  // 1 — THE TICKET, caught from outside: an open release PR whose required
  // contexts are parked. This is what nothing reported.
  {
    const r = run({
      pulls: openPr("2026-08-04T11:00:00Z"),
      checkRuns: checkRuns("action_required"),
    });
    assert(r.status === 1, `parked contexts must alarm, got ${r.status}: ${r.out}`);
    assert(r.out.includes("BLOCKED"), r.out);
    assert(r.out.includes("#281"), r.out);
  }

  // 2 — same PR, checks reporting, opened an hour ago: silence is correct.
  {
    const r = run({
      pulls: openPr("2026-08-04T11:00:00Z"),
      checkRuns: checkRuns("success"),
    });
    assert(r.status === 0, `a healthy fresh release PR must not alarm: ${r.out}`);
  }

  // 3 — healthy checks but open past the age limit: the catch-all.
  {
    const r = run({
      pulls: openPr("2026-07-28T11:00:00Z"),
      checkRuns: checkRuns("success"),
    });
    assert(r.status === 1, `an 7-day-old release PR must alarm: ${r.out}`);
    assert(r.out.includes("STALE"), r.out);
  }

  // 4 — no PR, changesets pending, last release run FAILED: nothing is coming.
  {
    const r = run(
      {
        pulls: [],
        releaseRuns: [{ conclusion: "failure", created_at: "2026-08-03T00:00:00Z" }],
      },
      ["brave-pugs-shake.md"],
    );
    assert(r.status === 1, `a failing release path must alarm: ${r.out}`);
    assert(r.out.includes("NO_RELEASE"), r.out);
  }

  // 5 — no PR, changesets pending, last release run SUCCEEDED *recently*. This
  // is the designed packages-v* wait (`ready=false` skips and still concludes
  // success). Alarming here would train everyone to mute it.
  {
    const r = run(
      {
        pulls: [],
        releaseRuns: [{ conclusion: "success", created_at: "2026-08-03T00:00:00Z" }],
      },
      ["brave-pugs-shake.md"],
    );
    assert(r.status === 0, `the designed packages-v* wait must not alarm: ${r.out}`);
  }

  // 5b — the same skip-success, but STALE. cli-release only fires on a push
  // touching `cli/**`, so once the batch publishes and nobody pushes again,
  // that skipped run stays the newest run forever, concluded `success`. An
  // unbounded tolerance for case 5 means this state is silent for eternity —
  // the ticket's own defect, one directory over. Caught in review of PR #300.
  {
    const r = run(
      {
        pulls: [],
        releaseRuns: [{ conclusion: "success", created_at: "2026-07-28T00:00:00Z" }],
      },
      ["brave-pugs-shake.md"],
    );
    assert(r.status === 1, `a week-old skip-success must alarm, got ${r.status}: ${r.out}`);
    assert(r.out.includes("NO_RELEASE"), r.out);
  }

  // 5c — changesets pending and cli-release has never run at all (workflow
  // deleted, disabled, or its trigger broken). Nothing is coming.
  {
    const r = run({ pulls: [], releaseRuns: [] }, ["brave-pugs-shake.md"]);
    assert(r.status === 1, `no cli-release run at all must alarm, got ${r.status}: ${r.out}`);
    assert(r.out.includes("never run"), r.out);
  }

  // 5d — a run stuck in progress for days is hung, not working.
  {
    const r = run(
      {
        pulls: [],
        releaseRuns: [{ conclusion: null, status: "in_progress", created_at: "2026-07-28T00:00:00Z" }],
      },
      ["brave-pugs-shake.md"],
    );
    assert(r.status === 1, `a hung release run must alarm, got ${r.status}: ${r.out}`);
  }

  // 5e — but a run in progress right now is just running.
  {
    const r = run(
      {
        pulls: [],
        releaseRuns: [{ conclusion: null, status: "in_progress", created_at: "2026-08-04T11:00:00Z" }],
      },
      ["brave-pugs-shake.md"],
    );
    assert(r.status === 0, `an in-flight release run must not alarm: ${r.out}`);
  }

  // 6 — nothing pending, nothing open: quiet.
  {
    const r = run({ pulls: [], releaseRuns: [] });
    assert(r.status === 0, `an idle release path must be quiet: ${r.out}`);
    assert(r.out.includes("nothing pending"), r.out);
  }

  // 7 — README.md is not a changeset. Counting it would make case 5's "pending"
  // branch fire forever on an empty queue.
  {
    const r = run({ pulls: [], releaseRuns: [{ conclusion: "failure" }] });
    assert(r.status === 0, `README.md must not count as a pending changeset: ${r.out}`);
  }

  // 8 — the alarm lives in its own workflow file, on its own schedule. Folding
  // it into cli-release.yml would delete it exactly when cli-release breaks.
  {
    const path = join(ROOT, ".github/workflows/check-release-staleness.yml");
    const y = readFileSync(path, "utf8");
    assert(/schedule:/.test(y) && /cron:/.test(y), "the alarm needs its own schedule");
    assert(/check-release-staleness\.mjs/.test(y), "the workflow must run the checker");
    assert(/issues:\s*write/.test(y), "the workflow must be able to file the tracking issue");
  }

  console.log("✅ check-release-staleness regression tests passed");
}

main();
