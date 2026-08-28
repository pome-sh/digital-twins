// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { DATASET, RETRY_POLICIES, WORLDS, resolveRow, rowIdFor, seedFor } from "../src/dataset.js";

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
  // refunds, the two runs would differ in two ways at once, every feedback key in
  // the experiment would be measuring a confound, and nothing would go red.
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
    expect(new Set(DATASET.map((row) => rowIdFor(row.inputs))).size).toBe(DATASET.length);
    expect(new Set(WORLDS.map((w) => w.chargeId)).size).toBe(WORLDS.length);
  });

  // The red has to be reachable. A dataset where no row can over-refund is a
  // demo of nothing; a dataset where every row does is indistinguishable from a
  // scorer stuck at zero.
  it("can go red and can go green", () => {
    const canOverRefund = DATASET.filter(
      (row) => row.metadata.losesFirstRefundResponse && row.inputs.policy === "retry-on-5xx",
    );
    expect(canOverRefund.length).toBeGreaterThanOrEqual(1);
    expect(DATASET.length - canOverRefund.length).toBeGreaterThanOrEqual(1);
  });

  // The rows uploaded to LangSmith carry IDS, not worlds. `evaluate()` reads its
  // examples back out of LangSmith's dataset store, so anything sent in `inputs`
  // is state this repo no longer owns: a seed round-tripped through a third
  // party's store is not the seed `test/task.test.ts` pins. Worlds and seeds stay
  // in code and the target resolves the ids.
  it("uploads ids, never a world or a seed", () => {
    for (const row of DATASET) {
      expect(Object.keys(row.inputs).sort()).toEqual(["policy", "world"]);
      expect(JSON.stringify(row.inputs)).not.toContain("ch_test_");
    }
  });
});

describe("resolveRow", () => {
  it("resolves a row's ids to this checkout's own world and arm", () => {
    const { world, policy } = resolveRow({ world: "duplicate-charge", policy: "retry-on-5xx" });

    expect(world.chargeId).toBe("ch_test_200");
    expect(policy.id).toBe("retry-on-5xx");
  });

  // THE DRIFT CASE, and it only exists on this platform. LangSmith's dataset is
  // the durable copy of the row set, so deleting or renaming a world in
  // `WORLDS` leaves rows behind that name a world this checkout does not have.
  // Resolving that to `undefined` would mint a sandbox with an undefined seed and
  // grade every criterion `skipped` — a row of blank cells, not a red.
  it("refuses a row naming a world this checkout does not have", () => {
    expect(() => resolveRow({ world: "world-that-was-deleted", policy: "retry-on-5xx" })).toThrow(
      /world-that-was-deleted/,
    );
  });

  it("refuses a row naming an arm this checkout does not have", () => {
    expect(() => resolveRow({ world: "duplicate-charge", policy: "retry-twice" })).toThrow(
      /retry-twice/,
    );
  });

  it("refuses a row with no ids on it at all", () => {
    expect(() => resolveRow({})).toThrow();
  });
});
