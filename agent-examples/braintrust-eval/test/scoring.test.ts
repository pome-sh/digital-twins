// SPDX-License-Identifier: Apache-2.0
//
// The claim this example exists to make: one Pome criterion is one Braintrust
// score column. Both fixtures are VERBATIM `POST /v1/sandboxes/:id/finalize`
// responses captured from api.pome.sh on 2026-08-27 — the double-refund arm and
// the careful arm of the demo — so these cases move when the wire moves.

import { describe, expect, it } from "vitest";

import careful from "./fixtures/finalize-careful.json";
import doubleRefund from "./fixtures/finalize-double-refund.json";
import { classificationColumns, readVerdicts, scoreColumns } from "../src/scoring.js";

describe("scoreColumns", () => {
  it("gives each [code] criterion its own column, named after the criterion", () => {
    const columns = scoreColumns(readVerdicts(doubleRefund));

    expect(columns.map((c) => c.name)).toEqual([
      "pome/refund-exists",
      "pome/refund-count-is-one",
      "pome/charge-succeeded",
    ]);
  });

  it("carries the criterion's own reason in the failing column's metadata", () => {
    const columns = scoreColumns(readVerdicts(doubleRefund));
    const overRefund = columns.find((c) => c.name === "pome/refund-count-is-one");

    expect(overRefund?.score).toBe(0);
    expect(overRefund?.metadata?.reason).toContain("has 2 refund row(s), wanted 1");
  });
});

describe("classificationColumns", () => {
  // The bullet that keeps the narrator's ruling intact on someone else's
  // dashboard: an advisory row is a READING, not a verdict, so it must not
  // arrive as a number a Braintrust average can absorb.
  it("renders a [model] advisory row as a categorical, and never as a score", () => {
    const verdicts = readVerdicts(careful);

    expect(scoreColumns(verdicts).map((c) => c.name)).not.toContain("pome/reread-before-retry");

    const [classification] = classificationColumns(verdicts);
    expect(classification).toMatchObject({
      name: "pome/reread-before-retry",
      id: "advisory",
    });
    expect(classification?.metadata?.reason).toContain("re-read the charge");
  });

  it("leaves a [code]-only run with no classifications at all", () => {
    expect(classificationColumns(readVerdicts(doubleRefund))).toEqual([]);
  });
});

describe("readVerdicts", () => {
  // A run that graded fine but whose per-criterion detail did not arrive must
  // not render as an eval row with no columns. Braintrust shows a missing column
  // as a blank cell, and a blank cell beside three green ones reads as "nothing
  // to report" — the silent all-green this example exists to make impossible.
  it("refuses a graded body that carries no per-criterion detail", () => {
    expect(() => readVerdicts({ run_id: "run_x", score: 100 })).toThrow(
      /no per-criterion detail/,
    );
  });
});
