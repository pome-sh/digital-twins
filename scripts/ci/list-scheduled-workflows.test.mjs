#!/usr/bin/env node
// Regression coverage for scripts/ci/list-scheduled-workflows.mjs (F-1230).
// Builds a scratch .github/workflows tree so the assertions do not depend on
// which workflows this repo happens to carry today.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findScheduledWorkflows,
  findCronWorkflows,
  findBrokenLocalUses,
} from "./list-scheduled-workflows.mjs";

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
// The three YAML shapes the first revision of the parser silently missed. Each
// is a scheduled workflow that would have gone uncovered, invisibly, because
// the only floor was "at least one workflow is scheduled" — which the three
// real ones satisfy forever.
withScratchRoot(
  {
    // `on` is YAML 1.1 truthy, so yamllint's standard workaround is to quote it.
    "quoted-on.yml": "name: x\n\"on\":\n  schedule:\n    - cron: '0 0 * * *'\njobs: {}\n",
    // Flow form entirely on the `on:` line.
    "flow-on.yml": "name: x\non: {schedule: [{cron: '0 0 * * *'}]}\njobs: {}\n",
    // Four-space indent under `on:`, and an inline value on `schedule:`.
    "deep-indent.yml": "name: x\non:\n    schedule: [{cron: '0 0 * * *'}]\njobs: {}\n",
  },
  (root) => {
    const found = findScheduledWorkflows(root);
    for (const expected of ["quoted-on.yml", "flow-on.yml", "deep-indent.yml"]) {
      assert(found.includes(expected), `${expected} must count as scheduled, got ${found}`);
    }
    // The half this fixture used to leave untested, and the reason it mattered:
    // asserting only the `on: schedule:` read said nothing about the SET
    // EQUALITY main() enforces between the two reads. The `cron:` read was
    // anchored at line start, so it missed `schedule: [{cron: …}]` — meaning
    // two of the three shapes this very fixture proves are parsed would have
    // FAILED main()'s cross-check. A correctly-alarmed workflow red the guard.
    const cron = findCronWorkflows(root);
    for (const expected of ["quoted-on.yml", "flow-on.yml", "deep-indent.yml"]) {
      assert(cron.includes(expected), `${expected} must also be seen by the cron: read, or main()'s set-equality reds a correct workflow; got ${cron}`);
    }
    assert(
      found.length === cron.length,
      `the two reads must agree exactly on these shapes, got ${found} vs ${cron}`,
    );
  },
);

// A flow mapping that SPANS lines (`on: {` with the keys below it) is read by
// neither rule, so a cron inside one is invisible to both — and two blind reads
// agree, so the set-equality cross-check has nothing to disagree about and the
// alarm-coverage check reports a clean pass on an unalarmed cron. actionlint
// accepts the shape as valid workflow YAML, so nothing else catches it either.
// An unsupported shape must be LOUD, never indistinguishable from an absent
// trigger.
withScratchRoot(
  {
    "multiline-flow-on.yml": 'name: x\non: {\n  schedule: [{cron: "0 3 * * *"}]\n}\njobs: {}\n',
  },
  (root) => {
    let threw = false;
    try {
      findScheduledWorkflows(root);
    } catch (err) {
      threw = true;
      assert(/block form/.test(err.message), `expected the error to name the remedy, got ${err.message}`);
    }
    assert(threw, "a multi-line flow on: mapping must throw, not silently report zero scheduled workflows");
  },
);

// The cross-check floor: the `cron:` read and the `on: schedule:` read are two
// independent rules over the same fact, so a parser that stops matching one
// workflow shows up as a set difference rather than as a still-non-zero count.
withScratchRoot(
  {
    "scheduled.yml": "name: x\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs: {}\n",
    "plain.yml": "name: y\non:\n  push:\n    branches: [main]\njobs: {}\n",
    // `cron:` only in prose must not count on the cron side either.
    "prose.yml": "name: z\n# nightly cron: not a trigger\non:\n  push:\njobs: {}\n",
  },
  (root) => {
    const cron = findCronWorkflows(root);
    assert(
      cron.length === 1 && cron[0] === "scheduled.yml",
      `cron read must find exactly scheduled.yml, got ${cron}`,
    );
    assert(
      JSON.stringify(cron) === JSON.stringify(findScheduledWorkflows(root)),
      "the two reads must agree on this fixture",
    );
  },
);

// A wired-but-BROKEN alarm: the job is present, the `uses:` path is a typo, and
// GitHub would refuse to run the workflow. Nothing else in CI catches this —
// actionlint is not wired in, and the reusable call is never exercised on a PR.
withScratchRoot(
  {
    "caller.yml":
      "name: x\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  a:\n    uses: ./.github/workflows/typo.yml\n  b:\n    uses: ./.github/workflows/real.yml\n",
    "real.yml": "name: r\non:\n  workflow_call:\njobs: {}\n",
  },
  (root) => {
    const broken = findBrokenLocalUses(root);
    assert(
      broken.length === 1 && broken[0].includes("typo.yml"),
      `only the typo'd uses: must be reported, got ${JSON.stringify(broken)}`,
    );
  },
);

{
  const real = findScheduledWorkflows(fileURLToPath(new URL("../..", import.meta.url)));
  for (const expected of ["repo-policy.yml", "secret-scan.yml", "release-alarm.yml"]) {
    assert(real.includes(expected), `expected ${expected} in the real tree's scheduled set, got ${real}`);
  }
}

console.log("✅ list-scheduled-workflows.test.mjs passed");
