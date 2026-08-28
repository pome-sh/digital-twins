// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import careful from "./fixtures/finalize-careful.json";
import doubleRefund from "./fixtures/finalize-double-refund.json";
import { evalOptions, exitCodeFor, formatRowReport, formatSummary, pomeVerdicts } from "../src/index.js";
import { readVerdicts, readingFeedback, scoreFeedback } from "../src/scoring.js";
import type { PomeRunEvidence } from "../src/pome.js";

function evidenceFrom(body: unknown, score: number): PomeRunEvidence {
  const verdicts = readVerdicts(body);
  return {
    sessionId: "ses_fixture",
    runId: "run_fixture",
    score,
    dashboardUrl: "https://app.pome.sh/runs/run_fixture",
    verdicts,
    scores: scoreFeedback(verdicts),
    readings: readingFeedback(verdicts),
  };
}

describe("pomeVerdicts", () => {
  // The ticket's second bullet: the evaluator reads outputs["pome"] and returns
  // one entry per criterion. In JS/TS that is `{results: [...]}`; the Python SDK
  // takes a bare list. Both field names matter — `key` here, `name` in Braintrust.
  it("returns one entry per criterion, wrapped in the JS/TS `{results}` envelope", () => {
    const feedback = pomeVerdicts({ outputs: { answer: "done", pome: evidenceFrom(careful, 100) } });

    expect(feedback.results.map((r) => r.key)).toEqual([
      "pome/refund-exists",
      "pome/refund-count-is-one",
      "pome/charge-succeeded",
      "pome/reread-before-retry",
      "pome/run-score",
    ]);
  });

  it("carries the [model] reading as a value and the [code] verdicts as scores", () => {
    const feedback = pomeVerdicts({ outputs: { answer: "done", pome: evidenceFrom(careful, 100) } });
    const reading = feedback.results.find((r) => r.key === "pome/reread-before-retry")!;
    const code = feedback.results.find((r) => r.key === "pome/refund-count-is-one")!;

    expect(reading).toMatchObject({ value: "advisory" });
    expect("score" in reading).toBe(false);
    expect(code.score).toBe(1);
  });

  it("adds Pome's own run score as one more key, on a 0–1 scale", () => {
    const feedback = pomeVerdicts({ outputs: { answer: "x", pome: evidenceFrom(doubleRefund, 67) } });

    expect(feedback.results.find((r) => r.key === "pome/run-score")?.score).toBeCloseTo(0.67);
  });

  // An empty results array is not an error to LangSmith and does not become one:
  // `_selectEvalResults` reads the empty array, iterates it zero times, and calls
  // `createFeedback` never — no throw, no log, no feedback. So a row whose
  // evaluator returned nothing looks exactly like a row whose criteria were all
  // fine. `readVerdicts` refusing an empty breakdown is what keeps this
  // non-empty; `exitCodeFor` below is the backstop if it ever is not.
  it("never returns an empty results array", () => {
    for (const [body, score] of [[careful, 100], [doubleRefund, 67]] as const) {
      expect(pomeVerdicts({ outputs: { answer: "x", pome: evidenceFrom(body, score) } }).results.length)
        .toBeGreaterThan(0);
    }
  });

  // `_runEvaluators` catches an evaluator's throw, `console.error`s it and moves
  // on, so a row whose evaluator failed still finishes — with no Pome feedback
  // and nothing in the exit code. Throwing here is still right (it names the
  // problem in the log); `exitCodeFor` below is what makes it fail the run.
  it("refuses an output with no Pome evidence on it", () => {
    expect(() => pomeVerdicts({ outputs: { answer: "done" } })).toThrow(/pome/i);
  });
});

describe("exitCodeFor", () => {
  const graded = {
    run: { error: null },
    evaluationResults: { results: [{ key: "pome/refund-exists", score: 1 }] },
  };

  // `_forward` catches the target's error, prints it, and returns the row anyway.
  // Left alone, an eval in which every single row failed to mint a sandbox exits
  // 0 and reads, from CI, exactly like one that passed.
  it("is non-zero when any row errored", () => {
    expect(exitCodeFor([graded, { ...graded, run: { error: "mint failed" } }])).toBe(1);
  });

  it("is zero when every row ran, however it scored", () => {
    // A row that ran and came back RED is a successful eval. The exit code is
    // about whether the harness worked, never about the verdict — a dataset
    // whose red rows failed the process could not have a red row on purpose.
    expect(
      exitCodeFor([graded, { ...graded, evaluationResults: { results: [{ key: "pome/x", score: 0 }] } }]),
    ).toBe(0);
  });

  it("is non-zero when the eval produced no rows at all", () => {
    expect(exitCodeFor([])).toBe(1);
  });

  // THE SWALLOWED-EVALUATOR CASE. `_runEvaluators` logs an evaluator's throw and
  // continues, so a row can finish with `run.error` unset and no Pome feedback at
  // all — every Pome key a blank cell, which in an experiment table reads like a
  // quiet afternoon rather than like the failure it is.
  it("is non-zero when a row carries no Pome feedback", () => {
    expect(exitCodeFor([graded, { run: { error: null }, evaluationResults: { results: [] } }])).toBe(1);
  });

  it("ignores a row's non-Pome feedback when deciding that", () => {
    expect(
      exitCodeFor([{ run: { error: null }, evaluationResults: { results: [{ key: "my/own-scorer", score: 1 }] } }]),
    ).toBe(1);
  });
});

describe("evalOptions", () => {
  // One sandbox per row, all at once, is how a reader trips 402 quota_exceeded on
  // their first run. Two at a time is slower and finishes.
  it("caps how many sandboxes are open at once, and lets that be raised", () => {
    expect(evalOptions({}).maxConcurrency).toBe(2);
    expect(evalOptions({ POME_EVAL_CONCURRENCY: "5" }).maxConcurrency).toBe(5);
  });

  it("ignores a POME_EVAL_CONCURRENCY that is not a positive whole number", () => {
    for (const bogus of ["0", "-3", "two", "2.5", ""]) {
      expect(evalOptions({ POME_EVAL_CONCURRENCY: bogus }).maxConcurrency).toBe(2);
    }
  });

  // THE UNBOUNDED CASE, and it is why `0` is not merely a silly value here.
  // `_evaluate` reads `maxConcurrency ?? 0` and only builds a queue `if
  // (sharedConcurrency > 0)` — so 0, or absent, means EVERY row runs at once and
  // every row mints a billable sandbox. The floor is the guard.
  it("never yields a cap of 0 or undefined, which LangSmith reads as unbounded", () => {
    for (const env of [{}, { POME_EVAL_CONCURRENCY: "0" }, { POME_EVAL_CONCURRENCY: "nope" }]) {
      const { maxConcurrency } = evalOptions(env);
      expect(Number.isInteger(maxConcurrency)).toBe(true);
      expect(maxConcurrency).toBeGreaterThan(0);
    }
  });
});

describe("formatRowReport", () => {
  const evidence = evidenceFrom(doubleRefund, 67);

  // LangSmith's `evaluate()` prints the experiment name and a compare URL and
  // nothing else, so without this the one thing this example is about — which
  // criterion went red on which row — is visible only in a browser.
  it("names the criterion that went red, and why", () => {
    const report = formatRowReport("duplicate-charge · retry-on-5xx", evidence);

    expect(report).toContain("duplicate-charge · retry-on-5xx");
    expect(report).toContain("FAIL  pome/refund-count-is-one");
    expect(report).toContain("has 2 refund row(s), wanted 1");
  });

  // A [code] criterion that could not be evaluated is neither a pass nor a fail,
  // and printing it as either is how a skipped criterion gets read as a verdict.
  it("keeps pass, fail and could-not-say distinguishable", () => {
    const withSkip = {
      ...evidence,
      scores: evidence.scores.map((entry) =>
        entry.key === "pome/charge-succeeded"
          ? { ...entry, score: null, comment: "state_incomplete" }
          : entry,
      ),
    };
    const report = formatRowReport("row", withSkip);

    expect(report).toMatch(/PASS +pome\/refund-exists/);
    expect(report).toMatch(/FAIL +pome\/refund-count-is-one/);
    expect(report).toMatch(/SKIP +pome\/charge-succeeded/);
  });

  it("shows a [model] reading as its category, never as a pass or a fail", () => {
    const report = formatRowReport("row", evidenceFrom(careful, 100));

    expect(report).toContain("advisory");
    expect(report).not.toMatch(/(PASS|FAIL) +pome\/reread-before-retry/);
  });
});

describe("formatSummary", () => {
  it("prints a numeric key as a percentage and a categorical one as its tally", () => {
    const printed = formatSummary([
      { key: "pome/refund-count-is-one", kind: "numeric", mean: 2 / 3, counted: 6, unanswered: 0 },
      { key: "pome/checked-before-retrying", kind: "categorical", values: { advisory: 4, abstained: 2 } },
    ]);

    expect(printed).toContain("pome/refund-count-is-one");
    expect(printed).toContain("66.67%");
    expect(printed).toContain("advisory 4");
    expect(printed).toContain("abstained 2");
  });

  // A percentage over four of six rows is not a percentage over six, and printing
  // it as one hides that two rows could not be evaluated at all.
  it("says how many rows a numeric key could not be evaluated on", () => {
    const printed = formatSummary([
      { key: "pome/charge-succeeded", kind: "numeric", mean: 1, counted: 4, unanswered: 2 },
    ]);

    expect(printed).toMatch(/2 .*(could not|unanswered|not evaluated)/i);
  });
});
