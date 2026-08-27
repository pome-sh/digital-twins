// SPDX-License-Identifier: Apache-2.0
//
// The one claim this whole example rests on, checked against LangSmith's actual
// SDK rather than against its documentation: one Pome criterion becomes one
// LangSmith feedback key, and a `[model]` reading arrives as a categorical that
// never becomes a number.
//
// It runs the REAL `evaluate()` — the real target wrapping, the real
// `DynamicRunEvaluator` coercion, the real feedback assembly — against a stub
// `Client`, so it is hermetic: no account, no key, no network. LangSmith has no
// `noSendLogs` (see `src/langsmith.ts`), so the client is the only seam where
// this can be cut.
//
// Why bother, when `test/scoring.test.ts` already asserts the shapes: the SDK
// does not reject a wrong shape, it carries it. An evaluator that returned
// Braintrust's `name` field — the single most likely porting mistake in this
// file's whole neighbourhood — reaches `createFeedback(runId, undefined, …)` with
// the criterion's identity already gone, and nothing throws anywhere on the way.
// Only a test that goes through their coercion can see that.

import { describe, expect, it } from "vitest";

import { evaluate } from "langsmith/evaluation";
import type { EvaluationResult } from "langsmith/evaluation";
import type { Client } from "langsmith";

import careful from "./fixtures/finalize-careful.json";
import doubleRefund from "./fixtures/finalize-double-refund.json";
import { EVALUATORS, exitCodeFor } from "../src/index.js";
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

const DATASET_ID = "8f2a1c40-0000-4000-8000-000000000001";

function exampleFor(row: string, index: number) {
  return {
    id: `8f2a1c40-0000-4000-8000-00000000001${index}`,
    dataset_id: DATASET_ID,
    inputs: { row },
    outputs: undefined,
    created_at: new Date(0).toISOString(),
    modified_at: new Date(0).toISOString(),
    runs: [],
  };
}

/**
 * The smallest `Client` `evaluate()` will run against.
 *
 * Every method here is one `_runner.js` actually calls. `feedbackByRow` is what
 * the assertions read: it is the payload that WOULD have gone to
 * `POST /feedback`, captured at the point the SDK hands it over, after its own
 * coercion has had its say.
 */
function stubClient() {
  const feedbackByRow = new Map<string, EvaluationResult[]>();
  const calls: string[] = [];

  const client = {
    async *listExamples() {
      calls.push("listExamples");
      yield exampleFor("double-refund", 0);
      yield exampleFor("careful", 1);
    },
    async createProject() {
      calls.push("createProject");
      return { id: "8f2a1c40-0000-4000-8000-0000000000ff", name: "pome-refund-agent-selftest" };
    },
    async getDatasetUrl() {
      return `https://smith.langchain.test/datasets/${DATASET_ID}`;
    },
    async updateProject() {
      calls.push("updateProject");
    },
    async awaitPendingTraceBatches() {},
    async createRun() {},
    async updateRun() {},
    async logEvaluationFeedback(params: { evaluatorResponse: unknown; run: { id: string } }) {
      calls.push("logEvaluationFeedback");
      const response = params.evaluatorResponse as
        | { results?: EvaluationResult[] }
        | EvaluationResult;
      const results =
        response && typeof response === "object" && "results" in response && response.results
          ? response.results
          : [response as EvaluationResult];
      feedbackByRow.set(params.run.id, results);
      return results;
    },
  };

  return { client: client as unknown as Client, feedbackByRow, calls };
}

describe("the LangSmith seam", () => {
  it("turns each Pome criterion into its own feedback key, and each reading into a category", async () => {
    const { client, feedbackByRow, calls } = stubClient();

    const results = await evaluate(
      async (inputs: { row: string }) => ({
        answer: "fixture",
        pome: inputs.row === "careful" ? evidenceFrom(careful, 100) : evidenceFrom(doubleRefund, 67),
      }),
      { data: "pome-selftest-dataset", evaluators: EVALUATORS, client },
    );

    // The floor. Every assertion below reads what the SDK handed the client, so a
    // stub the runner silently stopped calling — `_runEvaluators` swallows its own
    // errors — would leave the maps empty and every `find` undefined. This is what
    // makes an empty pass impossible.
    expect(calls).toContain("createProject");
    expect(calls.filter((c) => c === "logEvaluationFeedback")).toHaveLength(2);
    expect(results.results).toHaveLength(2);

    const rowFor = (row: string) =>
      feedbackByRow.get(results.results.find((r) => r.example.inputs.row === row)!.run.id)!;

    const red = rowFor("double-refund");
    const green = rowFor("careful");

    // Three [code] criteria, three keys — not one blob, and not one average.
    expect(new Map(red.map((f) => [f.key, f.score]))).toEqual(
      new Map([
        ["pome/refund-exists", 1],
        ["pome/refund-count-is-one", 0],
        ["pome/charge-succeeded", 1],
        ["pome/run-score", 0.67],
      ]),
    );

    // The advisory row is a CATEGORY. If it had been flattened to a number it
    // would show up here with a score, and this example would be re-importing
    // judge scoring onto the customer's dashboard.
    const reading = green.find((f) => f.key === "pome/reread-before-retry")!;
    expect(reading.value).toBe("advisory");
    expect(reading.score).toBeUndefined();
  });

  // THE KEYLESS-FEEDBACK CASE, and the reason this file runs the real SDK.
  // Braintrust reads `name`; LangSmith reads `key`. An evaluator ported by
  // copy-paste is not rejected: `coerceEvaluationResult` passes the entry through
  // untouched (`allowNoKey` is false for anything inside a `{results: […]}`
  // envelope, so no key is invented either), and `_logEvaluationFeedback` then
  // reads `res.key` — `undefined` — and hands it to `createFeedback` as the
  // feedback key. Nothing logs and nothing throws; the criterion is simply gone.
  //
  // The assertion is on `score`, not on the absence of a key, because "no entry
  // arrived at all" would satisfy an absence. The entry DOES arrive — carrying
  // its score, its `name`, and no key.
  it("carries an entry that says `name` through with no key at all, which is why ours says `key`", async () => {
    const { client, feedbackByRow } = stubClient();

    const results = await evaluate(async () => ({ answer: "fixture" }), {
      data: "pome-selftest-dataset",
      client,
      evaluators: [
        function braintrustShaped() {
          return { results: [{ name: "pome/refund-exists", score: 1 }] } as never;
        },
      ],
    });

    const [logged, ...rest] = feedbackByRow.get(results.results[0]!.run.id)!;
    expect(rest).toEqual([]);
    expect(logged?.score).toBe(1);
    expect(logged?.key).toBeUndefined();
    expect(logged).toMatchObject({ name: "pome/refund-exists" });
  });

  // THE DOUBLE-SWALLOW, end to end. `_forward` catches the target's error and
  // returns the row anyway; `_runEvaluators` then catches the evaluator's own
  // throw and continues. So a row that never minted a sandbox finishes with a
  // `run.error`, no feedback, and — left alone — an exit code of 0. An eval in
  // which every row failed would read from CI exactly like one that passed.
  //
  // This pins the two things `exitCodeFor` relies on actually being true of the
  // SDK: that the error lands on `run.error`, and that the row still appears in
  // the results at all.
  it("finishes a row whose target threw, with the error on the run and no feedback", async () => {
    const { client, calls } = stubClient();

    const results = await evaluate(
      async () => {
        throw new Error("mint failed: 402 quota_exceeded");
      },
      { data: "pome-selftest-dataset", evaluators: EVALUATORS, client },
    );

    expect(results.results).toHaveLength(2);
    expect(results.results[0]!.run.error).toContain("402 quota_exceeded");
    expect(results.results[0]!.evaluationResults.results).toEqual([]);
    expect(calls).not.toContain("logEvaluationFeedback");
    expect(exitCodeFor(results.results)).toBe(1);
  });
});
