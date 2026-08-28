// SPDX-License-Identifier: Apache-2.0
//
// The one claim this whole example rests on, checked against Braintrust's actual
// SDK rather than against its documentation: a scorer that returns an ARRAY of
// `{name, score}` emits one column PER ITEM, and a classifier returns a
// categorical that never becomes a number.
//
// Hermetic — `noSendLogs` runs the evaluator locally and builds a local summary
// instead of creating an experiment, so this needs no Braintrust account and
// makes no network call.

import { Eval } from "braintrust";
import { describe, expect, it } from "vitest";

import careful from "./fixtures/finalize-careful.json";
import doubleRefund from "./fixtures/finalize-double-refund.json";
import { pomeCriteria, pomeNarratorReadings, pomeRunScore } from "../src/index.js";
import { classificationColumns, readVerdicts, scoreColumns } from "../src/scoring.js";

const evidenceFrom = (body: unknown, score: number) => {
  const verdicts = readVerdicts(body);
  return {
    sessionId: "ses_fixture",
    runId: "run_fixture",
    score,
    dashboardUrl: "https://app.pome.sh/runs/run_fixture",
    verdicts,
    scores: scoreColumns(verdicts),
    classifications: classificationColumns(verdicts),
  };
};

describe("the Braintrust seam", () => {
  it("turns each Pome criterion into its own column, and each reading into a category", async () => {
    const { results } = await Eval(
      "pome-refund-agent-selftest",
      {
        data: [
          { input: { row: "double-refund" } },
          { input: { row: "careful" } },
        ],
        task: async (input: { row: string }) => ({
          summary: "fixture",
          pome:
            input.row === "careful"
              ? evidenceFrom(careful, 100)
              : evidenceFrom(doubleRefund, 67),
        }),
        scores: [pomeCriteria, pomeRunScore],
        classifiers: [pomeNarratorReadings],
      },
      { noSendLogs: true },
    );

    const red = results.find((r) => r.input.row === "double-refund")!;
    const green = results.find((r) => r.input.row === "careful")!;

    // Three [code] criteria, three columns — not one blob, and not one average.
    expect(red.scores).toMatchObject({
      "pome/refund-exists": 1,
      "pome/refund-count-is-one": 0,
      "pome/charge-succeeded": 1,
      "pome/run-score": 0.67,
    });

    // The advisory row is a CATEGORY. If it had been flattened to a number it
    // would show up here as a score, and this example would be re-importing
    // judge scoring onto the customer's dashboard.
    expect(green.classifications?.["pome/reread-before-retry"]).toEqual([
      expect.objectContaining({ id: "advisory" }),
    ]);
    expect(green.scores).not.toHaveProperty("pome/reread-before-retry");
  });
});
