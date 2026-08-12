#!/usr/bin/env node
// Regression coverage for scripts/ci/assert-schedule-alarm-coverage.mjs
// (F-1471). Builds scratch `.github/workflows` trees so every assertion is
// about the PARSER, not about which alarms this repo happens to carry today.
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
} from "./assert-schedule-alarm-coverage.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function withScratchRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "schedule-alarm-coverage-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  // Every fixture set needs the real reusable file to resolve `uses:`
  // targets against, same as production.
  writeFileSync(
    join(dir, "schedule-alarm.yml"),
    "name: schedule alarm\non:\n  workflow_call:\n    inputs:\n      title: {required: true, type: string}\n      label: {required: true, type: string}\n      outcome: {required: true, type: string}\njobs:\n  alarm:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo noop\n",
  );
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

// ── Direction 1: a scheduled workflow WITH a correctly-wired alarm passes ──
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

// ── Direction 2: adding a schedule: trigger with NO alarm reds, naming the file ──
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

// ── Break-on-purpose: uses: path typo'd — resolves to nothing, so the call
// is invisible to findScheduleAlarmCalls and the workflow reports missing.
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

// ── Break-on-purpose: title/label pair disagrees between the failure job
// and the recovery job — the alarm files under one key, looks up another.
withScratchRoot(
  {
    "mismatched.yml": `name: mismatched\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  schedule-alarm:\n    needs: main\n    if: failure()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "mismatched is failing"\n      label: "schedule-alarm:mismatched"\n      outcome: failure\n  schedule-alarm-recovery:\n    needs: main\n    if: success()\n    uses: ./.github/workflows/schedule-alarm.yml\n    with:\n      title: "mismatched is failing"\n      label: "schedule-alarm:mismatched-TYPO"\n      outcome: success\n`,
  },
  (root) => {
    const calls = findScheduleAlarmCalls(root);
    const mismatches = findTitleLabelMismatches(calls);
    assert(mismatches.length === 2, `expected both calls flagged, got ${JSON.stringify(mismatches)}`);
    // The failure leg is otherwise well-formed, so coverage itself is not
    // what this fixture is testing for — only the title/label disagreement.
    const missing = findMissingAlarmCoverage(root, calls);
    assert(missing.length === 0, `coverage should still be satisfied, got ${missing}`);
  },
);

// ── Break-on-purpose: the alarm job is commented out — comments are
// stripped before parsing, so there is nothing there to find, same as if it
// were never written.
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

// ── Break-on-purpose: continue-on-error: true at JOB level swallows the
// reusable call's own failure, so a broken alarm still reports green.
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

// ── Break-on-purpose: a neutralising if: false — the job is wired in text
// but can never run.
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

// ── Break-on-purpose: a step-level if: false (deeper than the job's own
// keys) must not be mistaken for the job-level if: that actually gates the
// alarm call. This is one of the three shapes that defeated a grep-based
// version of this exact check during F-1230's own review — a flat regex over
// lines would see the nearer "if: false" and misread a healthy job-level
// if: failure() as neutralised.
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

// ── Missing required input: label omitted entirely.
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

// ── A block-scalar `if:` (`if: >-`, spanning multiple lines) must still be
// read, and a "not failure()" shape (release-alarm.yml's real meta-alarm
// shape: gated on needs.*.result == 'failure' rather than the failure()
// function, because it is reporting on its OWN mechanism dying, not on the
// job it is attached to) must still count as long as outcome: failure is
// what is actually passed — that boolean literal is the real signal, not
// the spelling of the guard above it.
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

// ── A recovery-only workflow (no failure leg at all) must still be reported
// missing — outcome: success alone never covers the property.
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

// ── The bijection's OTHER direction. The fixture above is "same title, two
// labels"; this is "same label, two titles". A one-directional check would
// pass this, and it is the direction that actually breaks the mechanism the
// other way round: the failure leg files an issue titled one thing under a
// label whose recovery leg believes it is titled another, so whichever call
// creates the issue decides a title its sibling's prose contradicts.
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

// ── A `#` inside a title or label is NOT a YAML comment (a comment needs
// start-of-line or preceding whitespace, and never starts inside a quoted
// scalar). A blanket `#.*$` strip truncated both legs to the same mangled
// prefix, so the bijection compared two equal wrecks and reported green on
// precisely the typo it exists to catch. Issue refs like `#300` are all over
// this repo's prose, so this is a reachable shape, not a hypothetical.
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

// ── A real trailing comment on the same line still goes, so a commented-out
// key cannot be read as live state (the property the strip exists for).
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

// ── False red closed: flow-style `with: {…}`. GitHub accepts it, actionlint
// accepts it, and an earlier revision of the parser required `with:` alone on
// its line — so a CORRECTLY covered workflow was reported both uncovered and
// missing its inputs. A guard that reds on right answers gets deleted.
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

// ── Break-on-purpose: the alarm job needs only ONE of two work jobs.
// `failure()` is scoped to the alarm job's own dependency graph, so the
// sibling it does not depend on can fail while the alarm is simply SKIPPED and
// files nothing — wired in the diff, dead in production.
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

// ── The same shape done RIGHT must stay green, in both spellings and through
// a TRANSITIVE chain — requiring every work job to be listed DIRECTLY would
// red correct work, which is how a guard gets disabled.
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

// ── Against the real tree: main's three scheduled workflows all pass today.
{
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const calls = findScheduleAlarmCalls(root);
  const missing = findMissingAlarmCoverage(root, calls);
  assert(missing.length === 0, `real tree must have zero missing alarm coverage, got ${missing}`);
  assert(findMissingAlarmInputs(calls).length === 0, "real tree must have no missing alarm inputs");
  assert(findTitleLabelMismatches(calls).length === 0, "real tree must have no title/label mismatch");
  assert(findAlarmNeedsGaps(root).length === 0, `real tree's alarms must need every job in their own workflow, got ${JSON.stringify(findAlarmNeedsGaps(root))}`);
  // Not a vacuous pass: the real tree genuinely has calls to examine.
  assert(calls.length >= 3, `real tree must have alarm calls to examine, got ${calls.length}`);
}

console.log("✅ assert-schedule-alarm-coverage.test.mjs passed");
