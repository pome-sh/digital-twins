// SPDX-License-Identifier: Apache-2.0
// The golden-scenario CI gate — `agent-examples/support-triage`.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCodeCriteria } from "../../src/task/parseTask.js";
import { runGoldenScenario, type GoldenRunOutcome } from "./goldenRun.js";
import {
  correctAgent,
  nullAgent,
  wrongAgent,
  SUPPORT_TRIAGE_BREAKDOWN,
} from "./supportTriageFixtures.js";

// The example's real task file, not a copy.
const TASK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../agent-examples/support-triage/tasks/duplicate-issue.md",
);

const previousSecret = process.env.TWIN_AUTH_SECRET;

let correct: GoldenRunOutcome;
let wrong: GoldenRunOutcome;
let nothing: GoldenRunOutcome;

beforeAll(async () => {
  // Sequential, not concurrent: the runs share `process.env` for the twin
  // auth secret, and a gate that raced its own fixtures would be the flake this
  // one is supposed to be free of.
  correct = await runGoldenScenario(TASK, correctAgent);
  wrong = await runGoldenScenario(TASK, wrongAgent);
  nothing = await runGoldenScenario(TASK, nullAgent);
}, 60_000);

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const breakdownOf = (run: GoldenRunOutcome) =>
  Object.fromEntries(run.criteria.map((row) => [row.checkId ?? `UNBOUND:${row.text}`, row.status]));

describe("golden scenario — support-triage, known-correct vs known-wrong", () => {
  // The exhaustiveness arm, and the reason the table is keyed by check id.
  // It runs FIRST because every assertion below is only as good as the set of
  // criteria it ranges over: a task that grew a criterion nobody expected would
  // otherwise sail through with an unchanged aggregate.
  it("grades exactly the [code] criteria the task declares — no more, no fewer", async () => {
    const declared = readCodeCriteria(await readFile(TASK, "utf8"));
    const expected = Object.keys(SUPPORT_TRIAGE_BREAKDOWN).sort();
    const graded = correct.criteria.map((row) => row.checkId).sort();

    expect(correct.criteria).toHaveLength(declared.length);
    // Names the missing/extra row directly. This is the line that redded when the
    // positive tape assertion landed on this task; adding one entry to
    // `SUPPORT_TRIAGE_BREAKDOWN` was the whole integration.
    expect(graded).toEqual(expected);
    expect(wrong.criteria.map((row) => row.checkId).sort()).toEqual(expected);
  });

  it("the known-correct run satisfies every criterion, for the declared reason", () => {
    expect(breakdownOf(correct)).toEqual(
      Object.fromEntries(
        Object.entries(SUPPORT_TRIAGE_BREAKDOWN).map(([id, row]) => [id, row.correct]),
      ),
    );
  });

  it("the known-wrong run violates every criterion, for the declared reason", () => {
    expect(breakdownOf(wrong)).toEqual(
      Object.fromEntries(
        Object.entries(SUPPORT_TRIAGE_BREAKDOWN).map(([id, row]) => [id, row.wrong]),
      ),
    );
  });

  // The anti-vacuity arm. Every status above is `passed` or `failed`, so a skip
  // or an unbound sentence would already have failed one of them — but it would
  // fail as a value mismatch, and this says WHY out loud, with the check's own
  // reason attached. A criterion that stops being graded is the failure mode
  // this whole gate is aimed at; it deserves its own line.
  it("grades every criterion — none skipped, none binding nothing", () => {
    for (const run of [correct, wrong]) {
      const unanswered = run.criteria.filter(
        (row) => row.status === "skipped" || row.status === "unmatched",
      );
      expect(
        unanswered.map((row) => `${run.fixture}: ${row.checkId ?? row.text} → ${row.status} (${row.reason})`),
      ).toEqual([]);
      expect(run.gradedCount).toBe(Object.keys(SUPPORT_TRIAGE_BREAKDOWN).length);
    }
  });

  it("the correct run scores at or above the task's threshold, the wrong run below it", () => {
    // The threshold comes from the task's own `## Config` — 100 today. Reading
    // it rather than typing it means a task that relaxes its bar relaxes this
    // gate's bar with it, instead of the two disagreeing silently.
    expect(correct.passThreshold).toBe(wrong.passThreshold);
    expect(correct.satisfaction).toBeGreaterThanOrEqual(correct.passThreshold);
    expect(wrong.satisfaction).toBeLessThan(wrong.passThreshold);
    // Pinned, not merely compared: "at or above" is satisfied by 100 and by a
    // pipeline that returns 100 for everything, and the pair is what separates
    // them.
    expect([correct.satisfaction, wrong.satisfaction]).toEqual([100, 0]);
  });

  it("declares ZERO [model] criteria — this task's verdict has no judge in it", () => {
    // Pinned at zero, and this is the strongest single assertion in the file.
    //
    // Nothing in this task needs a judge. Whether the agent commented at all is
    // a question the tape answers deterministically, so asking a MODEL is strictly
    // worse. Whether the comment carried the customer's repro cannot be asked
    // without naming which issue the report had to be on: phrased without that,
    // it passed all 25 measured trials across both arms and three models —
    // INCLUDING runs that commented on the wrong issue. A free assertion, in
    // AutomationBench's sense, worth 20 points to every failing run.
    //
    // Zero is now a PROPERTY of this task and not an accident of the golden
    // harness: `support-triage` is the quickstart, every point it reports comes
    // from twin state or the recorded tape, and a judge re-entering here would
    // put grader variance back on the pass/fail boundary of the one lesson a
    // stranger walks first. Adding a `[model]` criterion to this task reds this
    // line, deliberately — argue it in the PR, do not relax it.
    expect(correct.modelCriteria).toBe(0);
    expect(wrong.modelCriteria).toBe(0);
    expect(nothing.modelCriteria).toBe(0);
  });

  // The Done-when, measured on the real task rather than on a hand-built tape: an
  // agent that does NOTHING must fail the tape criterion.
  it("THE NULL AGENT — doing nothing clears the prohibition and fails the tape criterion", () => {
    expect(breakdownOf(nothing)).toEqual({
      "github.no-new-issues": "passed",
      "slack.no-message-containing": "passed",
      "github.issue-comment-contains": "failed",
      "github.tool-was-called": "failed",
      "slack.message-contains": "failed",
    });

    // A real `failed`, never a skip. A skip would take the criterion out of the
    // denominator and hand the null agent its score back — the one outcome the
    // positive check exists to prevent, and the one that does not announce
    // itself. `gradedCount` is asserted for the same reason it is on the pair.
    expect(nothing.gradedCount).toBe(Object.keys(SUPPORT_TRIAGE_BREAKDOWN).length);
    expect(nothing.criteria.find((row) => row.checkId === "github.tool-was-called")?.reason).toContain(
      "0 call(s) inspected",
    );

    // And it does not clear the exam. Pinned rather than compared: 40 is
    // 2-of-5, so this also records that the criteria are IN the denominator.
    //
    // 40 IS NOT THE NUMBER A HOSTED RUN REPORTS FOR A NULL AGENT, and neither
    // side is wrong. This harness scores `passed / (passed + failed)` flat —
    // eleven lines of ratio arithmetic that exist to make the assertions above
    // expressible, as the header of `goldenRun.ts` says at length. The product's
    // engine lives in pome-cloud and excludes seed-true criteria: a criterion
    // true in the seed AND still true at finish leaves the denominator entirely. Both
    // negatives here are seed-true, so hosted grades a do-nothing agent 0-of-3
    // and reports 0. Do not "fix" either number into the other; the two graders
    // answer different questions and only the pass/fail below is common to them.
    expect(nothing.satisfaction).toBe(40);
    expect(nothing.satisfaction).toBeLessThan(nothing.passThreshold);
    expect(nothing.tape.tools).toEqual([]);
  });

  // A criterion reads this tape now, and the assertion stays because it is the
  // one that says WHY the verdict above is what it is. `tool-was-called`
  // reports only passed/failed; these four lines are where a reader sees that the
  // correct run's pass rests on a stamped `add_issue_comment` and the wrong run's
  // failure on a tape that names `create_issue` in its place — the difference
  // between a discriminating pair and a coincidence.
  //
  // Both tapes open with `list_issues`, and that shared row is doing work: it
  // says the pair differs in what the agent DID with what it found, not in
  // whether it bothered to look. A wrong fixture that skipped the search would
  // let a reader explain the whole verdict as "one of them was lazy".
  //
  // It also keeps the substrate honest in the direction that fails silently: a
  // tape with no `tool` on any row makes `github.tool-was-called` answer
  // `tool_not_recorded` and SKIP, which would quietly drop the criterion out of
  // the denominator rather than fail anyone. The no-skip arm above catches that;
  // this one names the cause.
  it("captures a per-twin tape with stamped tool names, which the tape criterion reads", () => {
    expect(correct.tape.byTwin).toEqual({ github: 2, slack: 1 });
    expect(correct.tape.tools).toEqual(["add_issue_comment", "list_issues", "slack_send_message"]);
    expect(wrong.tape.byTwin).toEqual({ github: 2, slack: 1 });
    expect(wrong.tape.tools).toEqual(["create_issue", "list_issues", "slack_send_message"]);
  });
});
