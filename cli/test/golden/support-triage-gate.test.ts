// SPDX-License-Identifier: Apache-2.0
//
// The golden-scenario CI gate (F-646) — `examples/support-triage`.
//
// WHY IT EXISTS. Nothing asserted end to end that the scoring pipeline produces
// the right answer for a run whose correctness is known by construction.
// Individual silent-scoring bugs were found and fixed one at a time — a matcher
// that hard-failed what it could not match (F-597), a lesson with no check that
// could express it so a duplicate-filing agent scored 100 (F-1198) — and the
// CLASS could regress freely, because every one of them was invisible: a wrong
// verdict looks exactly like a right one until someone reads the run.
//
// WHAT IT ASSERTS, and the order matters:
//
//   1. THE BREAKDOWN, per criterion. This is the assertion that catches "right
//      total, wrong reasons" — the aggregate agreeing for compensating errors.
//   2. THE DENOMINATOR. `gradedCount` is asserted for BOTH runs. Without it the
//      wrong run's 0 is satisfied by a pipeline that graded nothing at all,
//      which is the all-skip defect wearing the right answer's clothes.
//   3. NO SKIPS AND NO UNMATCHED, on both runs. A criterion that binds nothing
//      is dropped by the grader and the denominator moves for a reason nobody
//      wrote down; that is the silent one, so it is asserted directly rather
//      than inferred from the total.
//   4. THE AGGREGATE, last. It is the weakest of the four and it is the one the
//      ticket's headline names, which is exactly why it is not the only one.
//
// AND WHAT IT DOES NOT DO. It does not touch a model, a key, a socket or the
// network — the fixtures are scripts and the twins are in-process. `[model]`
// criteria are counted and deliberately not graded; the count is asserted so
// "no LLM in CI" is a property this file holds rather than a promise it makes.
//
// SCOPE (2026-08-12 scope note, One Working Curriculum M0). The pair covers the
// vertical slice: support-triage's task, github + slack. The stripe pair the
// original ticket asked for lands with M3's replication; the end state is still
// "github and stripe at minimum".

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCodeCriteria } from "../../src/task/parseTask.js";
import { runGoldenScenario, type GoldenRunOutcome } from "./goldenRun.js";
import { correctAgent, wrongAgent, SUPPORT_TRIAGE_BREAKDOWN } from "./supportTriageFixtures.js";

// The example's real task file, not a copy. A fixture of the task would drift
// from the task, and the drift would land on the side that says the gate is
// green — see F-1198's own history, where the corpus and the vocabulary
// disagreed for as long as nothing compared them.
const TASK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../examples/support-triage/tasks/duplicate-issue.md",
);

const previousSecret = process.env.TWIN_AUTH_SECRET;

let correct: GoldenRunOutcome;
let wrong: GoldenRunOutcome;

beforeAll(async () => {
  // Sequential, not concurrent: the two runs share `process.env` for the twin
  // auth secret, and a gate that raced its own fixtures would be the flake this
  // one is supposed to be free of.
  correct = await runGoldenScenario(TASK, correctAgent);
  wrong = await runGoldenScenario(TASK, wrongAgent);
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
    // Names the missing/extra row directly. When F-1338's positive tape
    // assertion lands on this task, THIS is the line that reds, and adding one
    // entry to `SUPPORT_TRIAGE_BREAKDOWN` is the whole integration.
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
    // The task declares two `[model]` criteria. They are counted and NOT graded:
    // a judge in CI would make this gate slow, paid and flaky, which is the
    // reason golden tasks are restricted to the `[code]` half.
    expect(correct.modelCriteria).toBe(2);
    expect(wrong.modelCriteria).toBe(2);
  });

  // The tape is captured for both runs even though no criterion reads it yet.
  // That is deliberate and it is the F-1338 slot: a `substrate: "tape"`
  // criterion needs a tape scoped to its twin, and the difference between "the
  // harness supplies one" and "the harness would have to be rewritten to supply
  // one" is the difference between a criterion landing in one line and landing
  // in a refactor. Asserting the stamped tool names keeps it honest — a tape
  // with no `tool` on it cannot answer a positive assertion about a call.
  it("captures a per-twin tape with stamped tool names, ready for a tape criterion", () => {
    expect(correct.tape.byTwin).toEqual({ github: 2, slack: 1 });
    expect(correct.tape.tools).toEqual(["add_issue_comment", "list_issues", "slack_send_message"]);
    expect(wrong.tape.byTwin).toEqual({ github: 1, slack: 1 });
    expect(wrong.tape.tools).toEqual(["create_issue", "slack_send_message"]);
  });
});
