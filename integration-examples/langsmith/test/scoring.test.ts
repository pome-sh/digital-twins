// SPDX-License-Identifier: Apache-2.0
//
// The claim this example exists to make: one Pome criterion is one LangSmith
// feedback key. Both fixtures are VERBATIM `POST /v1/sandboxes/:id/finalize`
// responses captured from api.pome.sh on 2026-08-27 — the double-refund arm and
// the careful arm of the demo — so these cases move when the wire moves. They
// are the same two fixtures `integration-examples/braintrust` pins, which is what
// makes the two examples' verdict rendering comparable at all.

import { describe, expect, it } from "vitest";

import careful from "./fixtures/finalize-careful.json";
import doubleRefund from "./fixtures/finalize-double-refund.json";
import { readVerdicts, readingFeedback, scoreFeedback } from "../src/scoring.js";
import type { PomeVerdict } from "../src/scoring.js";

describe("scoreFeedback", () => {
  it("gives each [code] criterion its own feedback key, named after the criterion", () => {
    const feedback = scoreFeedback(readVerdicts(doubleRefund));

    expect(feedback.map((f) => f.key)).toEqual([
      "pome/refund-exists",
      "pome/refund-count-is-one",
      "pome/charge-succeeded",
    ]);
  });

  // The field name is the one mechanical difference from Braintrust that a
  // copy-paste port gets wrong silently: Braintrust reads `name`, LangSmith reads
  // `key`. An entry carrying `name` is not rejected — `coerceEvaluationResult`
  // sees no `key` and stamps one from the evaluator FUNCTION's name, so every
  // criterion collapses into one feedback key called `pomeVerdicts` and the
  // per-criterion payoff silently disappears.
  it("says `key`, never Braintrust's `name`", () => {
    for (const entry of scoreFeedback(readVerdicts(doubleRefund))) {
      expect(entry).not.toHaveProperty("name");
      expect(typeof entry.key).toBe("string");
    }
  });

  it("carries the criterion's own reason as the feedback comment", () => {
    const overRefund = scoreFeedback(readVerdicts(doubleRefund)).find(
      (f) => f.key === "pome/refund-count-is-one",
    );

    expect(overRefund?.score).toBe(0);
    expect(overRefund?.comment).toContain("has 2 refund row(s), wanted 1");
  });

  // A [code] criterion that could not be evaluated is neither a pass nor a fail.
  // `ScoreType` is `number | boolean | null`, so `null` is a first-class answer
  // here and LangSmith leaves it out of that key's average — the honest
  // arithmetic for "we did not find out". Sending 0 would report a failure the
  // twin never observed.
  it("scores a [code] criterion that could not be evaluated as null, not 0", () => {
    const skipped: PomeVerdict[] = [
      { id: "refund-exists", kind: "code", status: "skipped", reason: "charge resolved nowhere", text: "…" },
    ];

    expect(scoreFeedback(skipped)).toEqual([
      expect.objectContaining({ key: "pome/refund-exists", score: null }),
    ]);
  });

  it("leaves the [model] criteria out of the numeric feedback entirely", () => {
    expect(scoreFeedback(readVerdicts(careful)).map((f) => f.key)).not.toContain(
      "pome/reread-before-retry",
    );
  });
});

describe("readingFeedback", () => {
  // The ticket's third bullet, and the one that keeps the narrator's ruling
  // intact on someone else's dashboard: an advisory row is a READING, not a
  // verdict, so it must arrive as LangSmith's categorical `{key, value}` and
  // never as a number an average can absorb.
  it("renders a [model] advisory row as a categorical value", () => {
    const [reading] = readingFeedback(readVerdicts(careful));

    expect(reading).toMatchObject({ key: "pome/reread-before-retry", value: "advisory" });
    expect(reading?.comment).toContain("re-read the charge");
  });

  // Not `score: undefined` — absent. `createFeedback` spreads whatever it is
  // handed straight into the `POST /feedback` body, so a `score` key that is
  // present and undefined is a `score` field on the wire, and a 0/1 read of a
  // reading is exactly what this example must not produce.
  it("attaches no score to a reading at all", () => {
    for (const reading of readingFeedback(readVerdicts(careful))) {
      expect("score" in reading).toBe(false);
    }
  });

  // The control plane is a tolerant-reader wire and may grow a score state. An
  // unrecognised one has to arrive as itself: coercing it into `advisory` would
  // report a reading that never happened, and dropping it would lose the row.
  it("passes an unrecognised narrator state through as its own value", () => {
    const grown: PomeVerdict[] = [
      { id: "checked-before-retrying", kind: "model", status: "deferred", reason: "", text: "…" },
    ];

    expect(readingFeedback(grown)).toEqual([
      expect.objectContaining({ key: "pome/checked-before-retrying", value: "deferred" }),
    ]);
  });

  // We deliberately do NOT send `feedbackConfig: {type: "categorical", categories:
  // [...]}`. It travels to `POST /feedback` and pins the accepted category set
  // for that key tenant-wide — "if a conflicting config exists for the same key,
  // a 400 error is raised" — so a control plane that grows a state would start
  // 400ing on a key that already has a config. The test above is the reason.
  it("declares no closed category set, so a new state cannot 400 the whole eval", () => {
    for (const reading of readingFeedback(readVerdicts(careful))) {
      expect("feedbackConfig" in reading).toBe(false);
    }
  });

  it("leaves a [code]-only run with no readings at all", () => {
    expect(readingFeedback(readVerdicts(doubleRefund))).toEqual([]);
  });
});

describe("readVerdicts", () => {
  // A run that graded fine but whose per-criterion detail did not arrive must not
  // render as an eval row with no Pome feedback. LangSmith shows a missing key as
  // a blank cell, and a blank cell beside three green ones reads as "nothing to
  // report" — the silent all-green this example exists to make impossible.
  it("refuses a graded body that carries no per-criterion detail", () => {
    expect(() => readVerdicts({ run_id: "run_x", score: 100 })).toThrow(/no per-criterion detail/);
  });
});
