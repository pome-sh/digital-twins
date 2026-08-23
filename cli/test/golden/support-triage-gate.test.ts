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
    // Names the missing/extra row directly. This is the line that redded when The
    // positive tape assertion sits on this task, and adding one entry to `SUPPORT_TRIAGE_BREAKDOWN`.
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

  it("runs no [model] criterion and no model — the gate is deterministic and free", () => {
    // The task declares ONE `[model]` criterion.
    expect(correct.modelCriteria).toBe(1);
    expect(wrong.modelCriteria).toBe(1);
  });

  // The Done-when, measured on the real task rather than on a hand-built tape: an
  // agent that does NOTHING must fail the tape criterion.
  it("THE NULL AGENT — doing nothing clears the prohibition and fails the tape criterion", () => {
    expect(breakdownOf(nothing)).toEqual({
      "github.no-new-issues": "passed",
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

    // And it does not clear the exam. Pinned rather than compared: 33 is
    // 1-of-3, so this also records that the criterion is IN the denominator.
    expect(nothing.satisfaction).toBe(33);
    expect(nothing.satisfaction).toBeLessThan(nothing.passThreshold);
    expect(nothing.tape.tools).toEqual([]);
  });

  // A criterion reads this tape now, and the assertion stays because it is the one
  // that says WHY the verdict above is what it is.
  it("captures a per-twin tape with stamped tool names, which the tape criterion reads", () => {
    expect(correct.tape.byTwin).toEqual({ github: 2, slack: 1 });
    expect(correct.tape.tools).toEqual(["add_issue_comment", "list_issues", "slack_send_message"]);
    expect(wrong.tape.byTwin).toEqual({ github: 1, slack: 1 });
    expect(wrong.tape.tools).toEqual(["create_issue", "slack_send_message"]);
  });
});
