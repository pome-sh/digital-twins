// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { DATASET, RETRY_POLICIES, WORLDS, seedFor } from "../src/dataset.js";

describe("the seeded worlds", () => {
  // THE TRAP. `packages/twin-stripe/src/domain/refunds.ts` computes
  // `refundable = charge.amount - charge.amount_refunded` and rejects
  // `amount > refundable` with `charge_already_refunded`. So a FULL refund that
  // loses its response is refused on the retry: one row is ever written,
  // `stripe.refund-count = 1` PASSES, and the demo silently shows all green
  // while demonstrating nothing. The over-refund only exists if the refund is
  // partial.
  it("refunds strictly less than the charge, or the second row can never land", () => {
    for (const world of WORLDS) {
      expect(
        world.refundMinorUnits,
        `world "${world.id}" refunds ${world.refundMinorUnits} of ${world.chargeMinorUnits} — ` +
          "a full refund is refused on the retry and the over-refund never happens",
      ).toBeLessThan(world.chargeMinorUnits);
    }
  });
});

describe("seedFor", () => {
  const [duplicateCharge] = WORLDS;
  const control = WORLDS.find((w) => !w.losesFirstRefundResponse)!;

  it("seeds the charge the criteria name, refundable and unrefunded", () => {
    const seed = seedFor(duplicateCharge);

    expect(seed.charges).toEqual([
      expect.objectContaining({
        id: duplicateCharge.chargeId,
        amount: duplicateCharge.chargeMinorUnits,
        amount_refunded: 0,
        status: "succeeded",
      }),
    ]);
    expect(seed.refunds).toEqual([]);
  });

  it("arms the lost response on the FIRST refund only, and after the write lands", () => {
    expect(seedFor(duplicateCharge).failure_injection).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/refunds",
        attempt: 1,
        mode: "after_handler",
        status: 500,
      }),
    ]);
  });

  it("leaves the control world with nothing injected", () => {
    expect(seedFor(control).failure_injection).toEqual([]);
  });
});

describe("the retry arms", () => {
  // Both arms must state the SAME refund task and differ only in what to do
  // when a write fails. If the safe arm also taught the agent something about
  // refunds, the two runs would differ in two ways at once, every column in the
  // experiment would be measuring a confound, and nothing would go red.
  it("differ in the retry rule and in nothing else", () => {
    const [a, b] = Object.values(RETRY_POLICIES);

    expect(a.retryRule).not.toBe(b.retryRule);
    expect(a.sharedDuties).toBe(b.sharedDuties);
  });

  it("both take a 5xx seriously — neither arm is told to give up", () => {
    for (const policy of Object.values(RETRY_POLICIES)) {
      expect(policy.retryRule).toMatch(/retry/i);
    }
  });
});

describe("DATASET", () => {
  it("is one row per world per arm, and at least five rows", () => {
    expect(DATASET).toHaveLength(WORLDS.length * Object.keys(RETRY_POLICIES).length);
    expect(DATASET.length).toBeGreaterThanOrEqual(5);
  });

  // Every row gets its OWN sandbox and its OWN seed. Distinct charge ids are
  // what makes a row that ended up in the wrong world visible: the criteria name
  // the charge, and a mismatched one SKIPS rather than passing.
  it("gives every row a distinct name and its own charge", () => {
    expect(new Set(DATASET.map((row) => row.input.rowId)).size).toBe(DATASET.length);
    expect(new Set(WORLDS.map((w) => w.chargeId)).size).toBe(WORLDS.length);
  });

  // The red has to be reachable. A dataset where no row can over-refund is a
  // demo of nothing; a dataset where every row does is indistinguishable from a
  // scorer stuck at zero.
  it("can go red and can go green", () => {
    const canOverRefund = DATASET.filter(
      (row) => row.input.world.losesFirstRefundResponse && row.input.policy === "retry-on-5xx",
    );
    expect(canOverRefund.length).toBeGreaterThanOrEqual(1);
    expect(DATASET.length - canOverRefund.length).toBeGreaterThanOrEqual(1);
  });
});
