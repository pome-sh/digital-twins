// SPDX-License-Identifier: Apache-2.0
//
// A misspelled seed field, read back off the twin's own surface.
//
// `z.object()` strips a key it does not recognise, so `amount_refunfed` was not
// an error — it was a zero, and the only place the difference showed was in what
// `GET /v1/charges/:id` answered. Measured 2026-08-29:
//
//   seed charge { amount_refunded: 20000 } → GET /v1/charges/ch → refunded true
//   seed charge { amount_refunfed: 20000 } → GET /v1/charges/ch → refunded false  ← the defect
//
// `refunded` is DERIVED (`serializers.ts`: `amount_refunded >= amount`), which is
// what makes this the sharpest reading of the defect available on this twin: the
// author writes one field, a different field on the wire comes back wrong, and
// the parse said nothing.

import { describe, expect, it } from "vitest";
import { openTwinStripeDatabase } from "../src/db.js";
import { StripeDomain } from "../src/domain/index.js";
import { loadSeedFromEnv, parseSeed } from "../src/seed.js";
import { applySeed } from "../src/apply-seed.js";
import type { SeedState } from "../src/types.js";

const SETTLED = {
  api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }],
  payment_intents: [
    {
      id: "pi_test_200",
      account_id: "acct_default",
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      client_secret: "pi_test_200_secret_test",
      latest_charge_id: "ch_test_200",
      created: 1700000000,
      updated: 1700000000,
    },
  ],
  charges: [
    {
      id: "ch_test_200",
      account_id: "acct_default",
      payment_intent_id: "pi_test_200",
      amount: 20000,
      amount_captured: 20000,
      amount_refunded: 20000,
      status: "succeeded",
      captured: true,
      currency: "usd",
      created: 1700000000,
    },
  ],
};

function chargeOnTheWire(seed: SeedState) {
  const db = openTwinStripeDatabase(":memory:");
  applySeed(db, seed);
  return new StripeDomain(db).retrieveCharge("acct_default", "ch_test_200") as {
    amount_refunded: number;
    refunded: boolean;
  };
}

describe("the field the author spelled right reads back", () => {
  it("serves a fully-refunded charge as refunded", () => {
    const charge = chargeOnTheWire(parseSeed(SETTLED));
    expect(charge.amount_refunded).toBe(20000);
    expect(charge.refunded).toBe(true);
  });
});

const TYPOS: Array<{ where: string; key: string; seed: unknown }> = [
  { where: "the root", key: "custmers", seed: { custmers: [] } },
  {
    where: "an api key",
    key: "acount_id",
    seed: { api_keys: [{ key: "sk_test_pome_default", sid: "default", acount_id: "acct_default" }] },
  },
  {
    where: "a charge",
    key: "amount_refunfed",
    seed: {
      ...SETTLED,
      charges: [{ ...SETTLED.charges[0], amount_refunfed: 20000 }],
    },
  },
  {
    where: "a payment intent",
    key: "capture_metod",
    seed: {
      ...SETTLED,
      payment_intents: [{ ...SETTLED.payment_intents[0], capture_metod: "manual" }],
    },
  },
  {
    where: "a refund",
    key: "resaon",
    seed: {
      refunds: [
        {
          id: "re_1",
          account_id: "acct_default",
          charge_id: "ch_test_200",
          payment_intent_id: "pi_test_200",
          amount: 100,
          currency: "usd",
          status: "succeeded",
          created: 1700000000,
          resaon: "requested_by_customer",
        },
      ],
    },
  },
  {
    where: "a balance transaction",
    key: "avilable_on",
    seed: {
      balance_transactions: [
        {
          id: "txn_1",
          account_id: "acct_default",
          type: "charge",
          amount: 100,
          net: 100,
          currency: "usd",
          available_on: 1700000000,
          created: 1700000000,
          avilable_on: 1700000000,
        },
      ],
    },
  },
  {
    where: "a failure-injection rule",
    key: "atempt",
    seed: {
      failure_injection: [
        { method: "POST", path: "/v1/refunds", attempt: 1, status: 500, body: {}, atempt: 2 },
      ],
    },
  },
];

describe("a key no seed field matches is refused, naming the key", () => {
  it.each(TYPOS)("$where: $key", ({ key, seed }) => {
    expect(() => parseSeed(seed)).toThrow(new RegExp(key));
  });

  it("refuses from POME_SEED_JSON rather than booting a world missing the row", () => {
    expect(() =>
      loadSeedFromEnv({ POME_SEED_JSON: JSON.stringify({ custmers: [] }) }),
    ).toThrow(/custmers/);
  });
});

describe("the `_meta` provenance block is not a typo", () => {
  it("is accepted and does not reach the parsed seed", () => {
    const parsed = parseSeed({
      _meta: { version: 1, source_hash: "sha256:hand-authored", model: "hand-authored" },
      ...SETTLED,
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("_meta");
    expect((parsed.charges as unknown[]).length).toBe(1);
  });
});
