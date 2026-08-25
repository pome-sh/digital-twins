#!/usr/bin/env node
//
// Every case is a workflow tree that LOOKS covered and is not: a commented-out
// alarm job, a continue-on-error, a dead if:, a title/label pair that disagrees.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findScheduleAlarmCalls,
  findMissingAlarmCoverage,
  findMissingAlarmInputs,
  findTitleLabelMismatches,
  findAlarmNeedsGaps,
  findSharedAlarmKeys,
  findUnclosableAlarms,
  findAlarmPermissionGaps,
  alarmRequiredScopes,
} from "./assert-schedule-alarm-coverage.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ALARM_FILE_YML =
  "name: schedule alarm\non:\n  workflow_call:\n    inputs:\n      title: {required: true, type: string}\n      label: {required: true, type: string}\n      outcome: {required: true, type: string}\npermissions:\n  contents: read\njobs:\n  alarm:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      issues: write\n    steps:\n      - uses: actions/checkout@v7\n      - run: bash scripts/ci/file-schedule-alarm.sh\n";

function withScratchRoot(files, fn, alarmFileYml = ALARM_FILE_YML) {
  const root = mkdtempSync(join(tmpdir(), "schedule-alarm-coverage-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  writeFileSync(join(dir, "schedule-alarm.yml"), alarmFileYml);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ALARM_JOB = (title, label) => `
  schedule-alarm:
    needs: main
    if: failure() && github.event_name == 'schedule'
    uses: ./.github/workflows/schedule-alarm.yml
    with:
      title: "${title}"
      label: "${label}"
      outcome: failure
  schedule-alarm-recovery:
    needs: main
    if: success() && github.event_name == 'schedule'
    uses: ./.github/workflows/schedule-alarm.yml
    with:
      title: "${title}"
      label: "${label}"
      outcome: success
`;

withScratchRoot(
  {
    "wired.yml": `name: wired\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n${ALARM_JOB("wired is failing", "schedule-alarm:wired")}`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.length === 0, `expected no missing coverage, got ${missing}`);
    assert(findMissingAlarmInputs(calls).length === 0, "expected no missing inputs");
    assert(findTitleLabelMismatches(calls).length === 0, "expected no title/label mismatch");
  },
);

withScratchRoot(
  {
    "unwired.yml": "name: unwired\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.length === 1 && missing[0] === "unwired.yml", `expected unwired.yml named, got ${missing}`);
  },
);

withScratchRoot(
  {
    "typo.yml":
      "name: typo\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/shcedule-alarm.yml\n    with:\n      title: \"typo is failing\"\n      label: \"schedule-alarm:typo\"\n      outcome: failure\n",
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 0, `typo'd uses: must not resolve to a call, got ${JSON.stringify(calls)}`);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.includes("typo.yml"), `typo.yml must be reported missing, got ${missing}`);
  },
);

withScratchRoot(
  {
    "mismatched.yml": `name: mismatched\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "mismatched is failing"\n      label: "schedule-alarm:mismatched"\n      outcome: failure\n  schedule-alarm-recovery:\n    needs: main\n    if: success()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "mismatched is failing"\n      label: "schedule-alarm:mismatched-TYPO"\n      outcome: success\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const mismatches = findTitleLabelMismatches(calls);
    assert(mismatches.length === 2, `expected both calls flagged, got ${JSON.stringify(mismatches)}`);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.length === 0, `coverage should still be satisfied, got ${missing}`);
  },
);

withScratchRoot(
  {
    "commented-out.yml":
      "name: commented-out\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n" +
      "#  schedule-alarm:\n" +
      "#    needs: main\n" +
      "#    if: failure()\n" +
      "#    uses: ./.github/workflows/schedule-alarm.yml\n" +
      "#    with:\n" +
      '#      title: "commented is failing"\n' +
      '#      label: "schedule-alarm:commented"\n' +
      "#      outcome: failure\n",
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 0, `a commented-out job must not parse as a call, got ${JSON.stringify(calls)}`);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.includes("commented-out.yml"), `commented-out.yml must be reported missing, got ${missing}`);
  },
);

withScratchRoot(
  {
    "swallowed.yml": `name: swallowed\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    continue-on-error: true\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "swallowed is failing"\n      label: "schedule-alarm:swallowed"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 1 && calls[0].continueOnError === "true", "expected the call to be parsed with continue-on-error captured");
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.includes("swallowed.yml"), `swallowed.yml must be reported missing despite the call existing, got ${missing}`);
  },
);

withScratchRoot(
  {
    "neutralised.yml": `name: neutralised\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: false\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "neutralised is failing"\n      label: "schedule-alarm:neutralised"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.includes("neutralised.yml"), `neutralised.yml must be reported missing, got ${missing}`);
  },
);

withScratchRoot(
  {
    "step-level-if.yml": [
      "name: step-level-if",
      "on:",
      "  schedule:",
      "    - cron: '0 0 * * *'",
      "jobs:",
      "  main:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "  schedule-alarm:",
      "    needs: main",
      "    if: failure()",
      "    uses: ./.github/workflows/schedule-alarm.yml",
      "    with:",
      '      title: "step-level is failing"',
      '      label: "schedule-alarm:step-level"',
      "      outcome: failure",
      "    steps:",
      "      - name: a step nested deeper than the job's own keys",
      "        if: false",
      "",
    ].join("\n"),
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 1, `expected exactly one call, got ${JSON.stringify(calls)}`);
    assert(calls[0].ifExpr === "failure()", `expected the job-level if: to win over the deeper step-level if: false, got ${calls[0].ifExpr}`);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.length === 0, `a healthy job-level if: must not be neutralised by an unrelated step's if: false, got ${missing}`);
  },
);

withScratchRoot(
  {
    "no-label.yml": `name: no-label\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "no-label is failing"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const missingInputs = findMissingAlarmInputs(calls);
    assert(missingInputs.length === 1 && missingInputs[0].file === "no-label.yml", `expected no-label.yml flagged, got ${JSON.stringify(missingInputs)}`);
  },
);

withScratchRoot(
  {
    "meta-shaped.yml": [
      "name: meta-shaped",
      "on:",
      "  schedule:",
      "    - cron: '0 0 * * *'",
      "jobs:",
      "  main:",
      "    runs-on: ubuntu-latest",
      "    outputs:",
      "      checked: ${{ steps.check.outcome }}",
      "    steps:",
      "      - run: echo hi",
      "  meta-alarm:",
      "    needs: main",
      "    if: >-",
      "      always() &&",
      "      needs.main.outputs.checked != 'success' &&",
      "      needs.main.outputs.checked != 'failure'",
      "    uses: ./.github/workflows/schedule-alarm.yml",
      "    with:",
      '      title: "meta-shaped mechanism is broken"',
      '      label: "schedule-alarm:meta-shaped"',
      "      outcome: failure",
      "",
    ].join("\n"),
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 1, `expected one call parsed, got ${JSON.stringify(calls)}`);
    assert(calls[0].ifExpr.includes("always()"), `expected the multi-line if: joined, got ${calls[0].ifExpr}`);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.length === 0, `a non-failure()-spelled but non-neutralised, outcome:failure call must count, got ${missing}`);
  },
);

withScratchRoot(
  {
    "recovery-only.yml": `name: recovery-only\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm-recovery:\n    needs: main\n    if: success()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "recovery-only is failing"\n      label: "schedule-alarm:recovery-only"\n      outcome: success\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.includes("recovery-only.yml"), `recovery-only.yml (no failure leg) must be reported missing, got ${missing}`);
  },
);

withScratchRoot(
  {
    "same-label.yml": `name: same-label\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "same-label is failing"\n      label: "schedule-alarm:same-label"\n      outcome: failure\n  schedule-alarm-recovery:\n    needs: main\n    if: success()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "same-label has recovered"\n      label: "schedule-alarm:same-label"\n      outcome: success\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const mismatches = findTitleLabelMismatches(calls);
    assert(mismatches.length === 2, `one label with two titles must flag both calls, got ${JSON.stringify(mismatches)}`);
  },
);

withScratchRoot(
  {
    "hashed.yml": `name: hashed\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "hashed is failing"\n      label: "schedule-alarm:hashed#1"\n      outcome: failure\n  schedule-alarm-recovery:\n    needs: main\n    if: success()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "hashed is failing"\n      label: "schedule-alarm:hashed#2"\n      outcome: success\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(
      calls[0].label === "schedule-alarm:hashed#1" && calls[1].label === "schedule-alarm:hashed#2",
      `a # inside a quoted value must survive comment stripping, got ${JSON.stringify(calls.map((c) => c.label))}`,
    );
    assert(findTitleLabelMismatches(calls).length === 2, "two labels differing only after a # must still be a mismatch");
  },
);

withScratchRoot(
  {
    "trailing.yml": `name: trailing\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure() # only on a real failure\n    uses: ./.github/workflows/schedule-alarm.yml # the shared alarm\n    with:\n      title: "trailing is failing"\n      label: "schedule-alarm:trailing"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 1 && calls[0].ifExpr === "failure()", `trailing comments must be stripped, got ${JSON.stringify(calls)}`);
    assert(findMissingAlarmCoverage(root, calls).length === 0, "a call with trailing comments is still covered");
  },
);

withScratchRoot(
  {
    "flow-with.yml": `name: flow-with\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with: {title: "flow is failing", label: "schedule-alarm:flow", outcome: failure}\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 1 && calls[0].outcome === "failure", `flow-form with: must parse, got ${JSON.stringify(calls)}`);
    assert(calls[0].title === "flow is failing" && calls[0].label === "schedule-alarm:flow", `flow-form title/label must parse, got ${JSON.stringify(calls[0])}`);
    assert(findMissingAlarmCoverage(root, calls).length === 0, "a flow-form alarm call is covered, not missing");
    assert(findMissingAlarmInputs(calls).length === 0, "a flow-form alarm call is not missing its inputs");
  },
);

withScratchRoot(
  {
    "partial-needs.yml": `name: partial-needs\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  trivial:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  realwork:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n  schedule-alarm:\n    needs: trivial\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "partial is failing"\n      label: "schedule-alarm:partial"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(findMissingAlarmCoverage(root, calls).length === 0, "the call itself is well-formed; this fixture is about the needs graph");
    const gaps = findAlarmNeedsGaps(root);
    assert(gaps.length === 1 && gaps[0].unseen.includes("realwork"), `realwork must be named as invisible to the alarm, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "flow-needs.yml": `name: flow-needs\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: [a, b]\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "flow-needs is failing"\n      label: "schedule-alarm:flow-needs"\n      outcome: failure\n`,
    "chained-needs.yml": `name: chained-needs\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  b:\n    needs:\n      - a\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: b\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "chained is failing"\n      label: "schedule-alarm:chained"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmNeedsGaps(root);
    assert(gaps.length === 0, `flow-form and transitive needs: must both count as covering, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "expr-false.yml": `name: expr-false\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: \${{ false }}\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "expr-false is failing"\n      label: "schedule-alarm:expr-false"\n      outcome: failure\n`,
    "expr-coe.yml": `name: expr-coe\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    continue-on-error: \${{ true }}\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "expr-coe is failing"\n      label: "schedule-alarm:expr-coe"\n      outcome: failure\n`,
  },
  (root) => {
    const missing = findMissingAlarmCoverage(root, findScheduleAlarmCalls(root));
    assert(missing.includes("expr-false.yml"), `\${{ false }} must neutralise, got ${missing}`);
    assert(missing.includes("expr-coe.yml"), `\${{ true }} continue-on-error must neutralise, got ${missing}`);
  },
);

withScratchRoot(
  {
    "tagged.yml": `name: tagged\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "tagged is failing"\n      label: "schedule-alarm:tagged"\n      outcome: !!str failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls[0].outcome === "failure", `an explicit YAML tag must not become part of the value, got ${JSON.stringify(calls[0].outcome)}`);
    assert(findMissingAlarmCoverage(root, calls).length === 0, "a tagged outcome: failure is still covered");
  },
);
withScratchRoot(
  {
    "block-title.yml": `name: block-title\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: >-\n        block scalar title\n      label: "schedule-alarm:block-title"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls[0].title !== ">-", "a bare block-scalar indicator must not be accepted as the title");
    assert(findMissingAlarmInputs(calls).length === 1, `an unreadable title must be reported MISSING, not accepted as ">-", got ${JSON.stringify(calls[0])}`);
  },
);

withScratchRoot(
  {
    "shared-a.yml": `name: shared-a\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n${ALARM_JOB("the weekly cron is failing", "schedule-alarm:weekly")}`,
    "shared-b.yml": `name: shared-b\non:\n  schedule:\n    - cron: '0 1 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n${ALARM_JOB("the weekly cron is failing", "schedule-alarm:weekly")}`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(findTitleLabelMismatches(calls).length === 0, "the pair is internally consistent — that is the point of this fixture");
    const shared = findSharedAlarmKeys(calls);
    assert(shared.length === 2, `both the shared label and the shared title must be reported, got ${JSON.stringify(shared)}`);
    assert(
      shared.every((s) => s.files.join() === "shared-a.yml,shared-b.yml"),
      `both offending files must be named, got ${JSON.stringify(shared)}`,
    );
  },
);

withScratchRoot(
  {
    "no-recovery.yml": `name: no-recovery\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "no-recovery is failing"\n      label: "schedule-alarm:no-recovery"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(findMissingAlarmCoverage(root, calls).length === 0, "the failure leg itself is well-formed; this fixture is about recovery");
    const unclosable = findUnclosableAlarms(calls);
    assert(
      unclosable.length === 1 && unclosable[0] === "schedule-alarm:no-recovery",
      `a failure leg with no recovery sibling must be named, got ${JSON.stringify(unclosable)}`,
    );
  },
);

withScratchRoot(
  {
    "no-issues.yml": `name: no-issues\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions:\n      contents: read\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "no-issues is failing"\n      label: "schedule-alarm:no-issues"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(
      gaps.length === 1 && gaps[0].file === "no-issues.yml" && gaps[0].job === "schedule-alarm",
      `expected no-issues.yml:schedule-alarm named, got ${JSON.stringify(gaps)}`,
    );
  },
);

withScratchRoot(
  {
    "read-all.yml": `name: read-all\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions: read-all\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "read-all is failing"\n      label: "schedule-alarm:read-all"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(gaps.length === 1, `read-all must gap, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "empty-map.yml": `name: empty-map\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions: {}\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "empty-map is failing"\n      label: "schedule-alarm:empty-map"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(gaps.length === 1, `permissions: {} must gap, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "absent-both.yml": `name: absent-both\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "absent-both is failing"\n      label: "schedule-alarm:absent-both"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(
      gaps.length === 1 && gaps[0].reason.includes("unstated repo default"),
      `permissions absent at both levels must gap naming the unstated default, got ${JSON.stringify(gaps)}`,
    );
  },
);

withScratchRoot(
  {
    "job-level-ok.yml": `name: job-level-ok\npermissions:\n  contents: read\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions:\n      contents: read\n      issues: write\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "job-level-ok is failing"\n      label: "schedule-alarm:job-level-ok"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(gaps.length === 0, `job-level issues: write must satisfy the requirement, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "workflow-level-ok.yml": `name: workflow-level-ok\npermissions:\n  contents: read\n  issues: write\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "workflow-level-ok is failing"\n      label: "schedule-alarm:workflow-level-ok"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(gaps.length === 0, `workflow-level fallback with issues: write must satisfy the requirement, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "write-all.yml": `name: write-all\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions: write-all\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "write-all is failing"\n      label: "schedule-alarm:write-all"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(gaps.length === 0, `write-all must satisfy the requirement, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "job-replaces-workflow.yml": `name: job-replaces-workflow\npermissions:\n  contents: read\n  issues: write\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions:\n      contents: read\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "job-replaces-workflow is failing"\n      label: "schedule-alarm:job-replaces-workflow"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(gaps.length === 1, `a job-level block must REPLACE, not merge with, a permissive workflow-level block, got ${JSON.stringify(gaps)}`);
  },
);

withScratchRoot(
  {
    "wired.yml": `name: wired\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions:\n      contents: read\n      issues: write\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "wired is failing"\n      label: "schedule-alarm:wired"\n      outcome: failure\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    assert(calls.length === 1, "the caller side is well-formed; this fixture breaks the callee");
    let threw = null;
    try {
      findAlarmPermissionGaps(root, calls);
    } catch (err) {
      threw = err.message;
    }
    assert(
      threw !== null && threw.includes("issues: write"),
      `the reusable alarm's own job losing issues: write must be a hard failure, got ${threw}`,
    );
  },
  ALARM_FILE_YML.replace("      issues: write\n", ""),
);

withScratchRoot(
  {
    "issues-only.yml": `name: issues-only\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions:\n      issues: write\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "issues-only is failing"\n      label: "schedule-alarm:issues-only"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(
      gaps.length === 1 && gaps[0].reason.includes("contents: read"),
      `a caller granting issues: write but not contents: read must gap naming contents: read, got ${JSON.stringify(gaps)}`,
    );
  },
);

withScratchRoot(
  {
    "quoted-keys.yml": `name: quoted-keys\n"permissions":\n  contents: read\n  "issues": write\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "quoted-keys is failing"\n      label: "schedule-alarm:quoted-keys"\n      outcome: failure\n`,
    "quoted-job-key.yml": `name: quoted-job-key\npermissions:\n  contents: read\n  issues: write\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    "permissions":\n      contents: read\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "quoted-job-key is failing"\n      label: "schedule-alarm:quoted-job-key"\n      outcome: failure\n`,
  },
  (root) => {
    const gaps = findAlarmPermissionGaps(root, findScheduleAlarmCalls(root));
    assert(
      gaps.length === 1 && gaps[0].file === "quoted-job-key.yml",
      `a quoted workflow-level/entry key must be read as a grant, and a quoted JOB-level block must still REPLACE the workflow-level one, got ${JSON.stringify(gaps)}`,
    );
  },
);

withScratchRoot(
  {
    "multiline-flow.yml": `name: multiline-flow\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    permissions: {\n      contents: read,\n      issues: write\n    }\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "multiline-flow is failing"\n      label: "schedule-alarm:multiline-flow"\n      outcome: failure\n`,
  },
  (root) => {
    let threw = null;
    try {
      findScheduleAlarmCalls(root);
    } catch (err) {
      threw = err.message;
    }
    assert(
      threw !== null && threw.includes("spans lines"),
      `a multi-line permissions: flow mapping must be refused by name, not read as an empty grant, got ${threw}`,
    );
  },
);

{
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const calls = findScheduleAlarmCalls(root);
  const missing = findMissingAlarmCoverage(root, calls);
  assert(missing.length === 0, `real tree must have zero missing alarm coverage, got ${missing}`);
  assert(findMissingAlarmInputs(calls).length === 0, "real tree must have no missing alarm inputs");
  assert(findTitleLabelMismatches(calls).length === 0, "real tree must have no title/label mismatch");
  assert(findAlarmNeedsGaps(root).length === 0, `real tree's alarms must need every job in their own workflow, got ${JSON.stringify(findAlarmNeedsGaps(root))}`);
  assert(findAlarmPermissionGaps(root, calls).length === 0, `real tree's calling jobs must all resolve the alarm's own scopes, got ${JSON.stringify(findAlarmPermissionGaps(root, calls))}`);
  assert(calls.length >= 3, `real tree must have alarm calls to examine, got ${calls.length}`);
  const required = alarmRequiredScopes(root);
  assert(
    required.get("issues") === "write" && required.size >= 2,
    `real tree's derived requirement must include issues: write and not be empty, got ${JSON.stringify([...required])}`,
  );
}

console.log("✅ assert-schedule-alarm-coverage.test.mjs passed");
