// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { evalOptions, exitCodeFor, formatRowReport } from "../src/index.js";

describe("exitCodeFor", () => {
  // Braintrust's `Eval()` collects a row's error into `results[].error` and
  // RESOLVES anyway — it does not throw and it does not set an exit code. An
  // example that just awaited it would exit 0 after an eval in which every
  // single row failed. `scripts/smoke-examples.mjs` calls that out by name: an
  // exit 0 against dead wiring means the failure was swallowed rather than
  // propagated.
  it("is non-zero when any row errored", () => {
    expect(exitCodeFor([{ error: undefined }, { error: new Error("mint failed") }])).toBe(1);
  });

  it("is zero when every row ran, however it scored", () => {
    // A row that ran and came back RED is a successful eval. The exit code is
    // about whether the harness worked, never about the verdict — a dataset
    // whose red rows failed the process could not have a red row on purpose.
    expect(exitCodeFor([{ error: undefined }, { error: undefined }])).toBe(0);
  });

  it("is non-zero when the eval produced no rows at all", () => {
    expect(exitCodeFor([])).toBe(1);
  });
});

describe("evalOptions", () => {
  // Without a Braintrust key the eval still RUNS — `noSendLogs` builds a local
  // summary instead of creating an experiment — so `npm start` works before you
  // have an account, and `smoke:examples` never reaches out to braintrust.dev on
  // a PR. Braintrust's own docs call this out for the CLI; it is the same switch.
  it("runs locally, without creating an experiment, when there is no Braintrust key", () => {
    expect(evalOptions({})).toMatchObject({ noSendLogs: true });
  });

  it("sends the experiment when a Braintrust key is present", () => {
    expect(evalOptions({ BRAINTRUST_API_KEY: "sk-bt-x" })).toMatchObject({ noSendLogs: false });
  });

  // One sandbox per row, all at once, is how a reader trips 402 quota_exceeded
  // on their first run. Two at a time is slower and finishes.
  it("caps how many sandboxes are open at once, and lets that be raised", () => {
    expect(evalOptions({}).maxConcurrency).toBe(2);
    expect(evalOptions({ POME_EVAL_CONCURRENCY: "5" }).maxConcurrency).toBe(5);
  });

  it("ignores a POME_EVAL_CONCURRENCY that is not a positive whole number", () => {
    for (const bogus of ["0", "-3", "two", "2.5", ""]) {
      expect(evalOptions({ POME_EVAL_CONCURRENCY: bogus }).maxConcurrency).toBe(2);
    }
  });
});

describe("formatRowReport", () => {
  const evidence = {
    sessionId: "ses_x",
    runId: "run_y",
    score: 67,
    dashboardUrl: "https://app.pome.sh/runs/run_y",
    verdicts: [],
    scores: [
      { name: "pome/refund-exists", score: 1, metadata: { reason: "has 2 refund row(s)" } },
      {
        name: "pome/refund-count-is-one",
        score: 0,
        metadata: { reason: "has 2 refund row(s), wanted 1" },
      },
      { name: "pome/charge-succeeded", score: null, metadata: { reason: "state_incomplete" } },
    ],
    classifications: [
      {
        name: "pome/checked-before-retrying",
        id: "advisory",
        label: "advisory — read, not scored",
        metadata: { reason: "the agent re-read the charge" },
      },
    ],
  };

  // Without a Braintrust account the eval still runs, but Braintrust's local
  // summary prints score AVERAGES and no classifications at all — so the one
  // thing this example is about, which criterion went red on which row, would be
  // invisible to a reader trying it for the first time.
  it("names the criterion that went red, and why", () => {
    const report = formatRowReport("duplicate-charge · retry-on-5xx", evidence);

    expect(report).toContain("duplicate-charge · retry-on-5xx");
    expect(report).toContain("FAIL  pome/refund-count-is-one");
    expect(report).toContain("has 2 refund row(s), wanted 1");
  });

  // A [code] criterion that could not be evaluated is neither a pass nor a fail,
  // and printing it as either is how a skipped criterion gets read as a verdict.
  it("keeps pass, fail and could-not-say distinguishable", () => {
    const report = formatRowReport("row", evidence);

    expect(report).toMatch(/PASS +pome\/refund-exists/);
    expect(report).toMatch(/FAIL +pome\/refund-count-is-one/);
    expect(report).toMatch(/SKIP +pome\/charge-succeeded/);
  });

  it("shows a [model] reading as its category, never as a pass or a fail", () => {
    const report = formatRowReport("row", evidence);

    expect(report).toContain("advisory");
    expect(report).not.toMatch(/(PASS|FAIL) +pome\/checked-before-retrying/);
  });
});
