#!/usr/bin/env node
// Regression coverage for scripts/ci/list-scheduled-workflows.mjs (F-1230).
// Builds a scratch .github/workflows tree so the assertions do not depend on
// which workflows this repo happens to carry today.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findScheduledWorkflows } from "./list-scheduled-workflows.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function withScratchRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "list-scheduled-wf-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A real schedule trigger is found.
withScratchRoot(
  {
    "scheduled.yml": "name: x\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs: {}\n",
    "not-scheduled.yml": "name: y\non:\n  push:\n    branches: [main]\njobs: {}\n",
  },
  (root) => {
    const found = findScheduledWorkflows(root);
    assert(found.length === 1 && found[0] === "scheduled.yml", `expected only scheduled.yml, got ${found}`);
  },
);

// A `schedule:` mentioned only in a comment, or inside a job step's shell
// text, must NOT count — the parser anchors on the top-level `on:` block, not
// on the string appearing anywhere in the file.
withScratchRoot(
  {
    "commented.yml":
      "name: x\n# schedule: this is not a trigger\non:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: echo schedule is a word here too\n",
  },
  (root) => {
    const found = findScheduledWorkflows(root);
    assert(found.length === 0, `commented-out schedule: must not count, got ${found}`);
  },
);

// A `schedule:` nested under a REUSABLE workflow's `workflow_call.inputs`
// (or any other non-top-level block) must not count either — anchored on the
// `on:` block specifically, indented exactly one level.
withScratchRoot(
  {
    "reusable.yml":
      "name: x\non:\n  workflow_call:\n    inputs:\n      schedule:\n        type: string\njobs: {}\n",
  },
  (root) => {
    const found = findScheduledWorkflows(root);
    assert(found.length === 0, `nested schedule: under workflow_call.inputs must not count, got ${found}`);
  },
);

// Vacuous-green guard: zero scheduled workflows across the whole tree throws
// rather than reporting a silent, technically-true empty list.
withScratchRoot({ "none.yml": "name: x\non:\n  push:\n    branches: [main]\njobs: {}\n" }, (root) => {
  let threw = false;
  try {
    // main() enforces the non-zero floor; findScheduledWorkflows() itself is
    // allowed to return an empty array (it is the honest primitive).
    const found = findScheduledWorkflows(root);
    assert(found.length === 0, "sanity: this fixture has no schedule trigger");
  } catch {
    threw = true;
  }
  assert(!threw, "findScheduledWorkflows itself must not throw on an empty result");
});

// Missing .github/workflows directory is a hard failure, not an empty list.
{
  const root = mkdtempSync(join(tmpdir(), "list-scheduled-wf-missing-"));
  let threw = false;
  try {
    findScheduledWorkflows(root);
  } catch {
    threw = true;
  }
  rmSync(root, { recursive: true, force: true });
  assert(threw, "a missing .github/workflows directory must throw, not report zero");
}

// Against the real tree: this repo carries at least repo-policy.yml,
// secret-scan.yml and release-alarm.yml on a schedule today. A regression
// here would mean the real-tree floor assertion (this same non-zero-count
// logic, run by main()) is not actually watching anything.
{
  const real = findScheduledWorkflows(new URL("../..", import.meta.url).pathname);
  for (const expected of ["repo-policy.yml", "secret-scan.yml", "release-alarm.yml"]) {
    assert(real.includes(expected), `expected ${expected} in the real tree's scheduled set, got ${real}`);
  }
}

console.log("✅ list-scheduled-workflows.test.mjs passed");
