// SPDX-License-Identifier: Apache-2.0
//
// The state readers Stripe's declared checks resolve through (F-1127).
//
// `checks-contract.test.ts` proves each declaration discriminates between the
// two worlds it names. That says nothing about the THIRD outcome — the one a
// resolver reaches when it cannot answer — and that outcome is where a wrong
// verdict actually comes from: a negative criterion handed a free pass because
// the charge it names was never in the export.
//
// So these test the reader directly, at the boundaries the fixtures deliberately
// avoid.

import { describe, expect, it } from "vitest";
import { refundsOnCharge, resolveCharge, type StripeCheckState } from "../src/check-state.js";
import { charge, refund, stripeState } from "../src/check-worlds.js";

describe("resolveCharge", () => {
  it("says state_incomplete when there is no `charges` key at all", () => {
    // Not "not found". A partial upload and an account with no charges are
    // different facts, and only one of them means the export is unusable.
    expect(resolveCharge({} as StripeCheckState, "ch_test_200")).toEqual({
      missing: "state_incomplete",
    });
  });

  it("says charge_not_found when the collection is present and the charge is not", () => {
    expect(resolveCharge(stripeState({ charges: [] }), "ch_test_200")).toEqual({
      missing: 'charge_not_found ("ch_test_200")',
      searched: "/charges",
    });
  });

  it("names the charge it could not find, so a report can act on it", () => {
    const missed = resolveCharge(stripeState({ charges: [charge({ id: "ch_other" })] }), "ch_typo");
    expect("missing" in missed && missed.missing).toContain("ch_typo");
  });

  it("matches EXACTLY — a charge id is minted, not typed", () => {
    // twin-slack's `resolveChannel` is case-insensitive and `#`-tolerant because
    // a channel name is something a human types. A charge id is an opaque
    // identifier the twin produced, so the same tolerance would only widen what a
    // typo can hit.
    const state = stripeState({ charges: [charge({ id: "ch_test_200" })] });
    expect(resolveCharge(state, "CH_TEST_200")).toEqual({
      missing: 'charge_not_found ("CH_TEST_200")',
      searched: "/charges",
    });
    expect(resolveCharge(state, "ch_test_200")).toEqual({
      found: charge({ id: "ch_test_200" }),
      path: "/charges/0",
    });
  });
});

describe("refundsOnCharge", () => {
  it("resolves the CHARGE first, so a missing charge never reads as zero refunds", () => {
    // The conflation this function exists to prevent. `The number of refunds on
    // charge "ch_x" is 0` must not PASS against an export that never held
    // `ch_x` — that is a clean bill issued over state nobody has.
    expect(refundsOnCharge(stripeState({ charges: [] }), "ch_test_200")).toEqual({
      missing: 'charge_not_found ("ch_test_200")',
      // F-1197 — the refusal names the collection it scanned, so a reader can
      // open it and see the id is genuinely not in it.
      searched: "/charges",
    });
  });

  it("says state_incomplete when the charge resolves but `refunds` is absent", () => {
    const partial = { charges: [charge({ id: "ch_test_200" })] } as StripeCheckState;
    expect(refundsOnCharge(partial, "ch_test_200")).toEqual({ missing: "state_incomplete" });
  });

  it("returns an EMPTY list for a real charge nobody refunded", () => {
    // A real answer, deliberately distinct from either skip above.
    const state = stripeState({ charges: [charge({ id: "ch_test_200" })], refunds: [] });
    // The path is the refunds COLLECTION, not a row: the filtered per-charge
    // list exists nowhere in the tree to point at (F-1197).
    expect(refundsOnCharge(state, "ch_test_200")).toEqual({ found: [], path: "/refunds" });
  });

  it("counts only the rows pointing at THIS charge", () => {
    const state = stripeState({
      charges: [charge({ id: "ch_a" }), charge({ id: "ch_b" })],
      refunds: [
        refund({ id: "re_1", charge: "ch_a" }),
        refund({ id: "re_2", charge: "ch_b" }),
        refund({ id: "re_3", charge: "ch_a" }),
      ],
    });
    const found = refundsOnCharge(state, "ch_a");
    expect("found" in found && found.found.map((row) => row.id)).toEqual(["re_1", "re_3"]);
  });

  it("reads the WIRE field `charge`, not the row column `charge_id`", () => {
    // The renaming `check-state.ts`'s header documents and
    // `fidelity-contract.test.ts` pins against a real export. Asserted here too,
    // from the reader's side: a row carrying only the column name must NOT count,
    // because silently counting it would let a model written against the seed
    // schema look correct.
    const state = stripeState({
      charges: [charge({ id: "ch_test_200" })],
      refunds: [{ id: "re_row_shaped", charge_id: "ch_test_200" } as never],
    });
    expect(refundsOnCharge(state, "ch_test_200")).toEqual({ found: [], path: "/refunds" });
  });
});
