// SPDX-License-Identifier: Apache-2.0
//
// A flat stripe seed carrying `refunds` and `balance_transactions` reaches the
// twin and READS BACK through the twin's own HTTP surface. No strip, no throw.
//
// Those two collections are the ones F-584 names: the twin has modelled them
// since scenario 14, and the task-side schema modelled neither, so a stripe task
// declaring a settled refund got a world with no refund in it. The task door is
// fixed by importing this schema (`cli/src/task/taskSchema.ts`); what THIS file
// asserts is the other end — that a seed the door now accepts produces rows the
// agent under test can actually see.
//
// Read back through `GET /v1/…`, not through `exportState` or a domain getter:
// the whole claim is "the world the author wrote is the world the agent finds",
// and the agent finds it over the wire.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, TEST_ACCOUNT_ID, TEST_SID, type StripeTestApp } from "./_appHelper.js";
import { applySeed } from "../src/apply-seed.js";
import { parseSeed } from "../src/seed.js";

/** The session the test bearer resolves to. Every seeded row is scoped to it,
 *  because a row on another account is a row this session cannot read — which
 *  would make a green test out of an invisible world. */
const ACCOUNT = TEST_ACCOUNT_ID;

/** A settled $200 charge, fully refunded, with the balance transactions both
 *  legs produce — every collection the seed models, none of them empty. */
const MID_FLOW = {
  api_keys: [{ key: "sk_test_pome_default", sid: TEST_SID, account_id: ACCOUNT }],
  payment_intents: [
    {
      id: "pi_test_200",
      account_id: ACCOUNT,
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      payment_method_types: ["crypto"],
      latest_charge_id: "ch_test_200",
      client_secret: "pi_test_200_secret_test",
      metadata: { order_id: "ord_88" },
      created: 1700000000,
      updated: 1700000600,
      captured_at: 1700000300,
    },
  ],
  charges: [
    {
      id: "ch_test_200",
      account_id: ACCOUNT,
      payment_intent_id: "pi_test_200",
      amount: 20000,
      amount_captured: 20000,
      amount_refunded: 20000,
      status: "succeeded",
      balance_transaction_id: "txn_test_200",
      captured: true,
      currency: "usd",
      created: 1700000300,
    },
  ],
  refunds: [
    {
      id: "re_test_200",
      account_id: ACCOUNT,
      charge_id: "ch_test_200",
      payment_intent_id: "pi_test_200",
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      reason: "requested_by_customer",
      balance_transaction_id: "txn_test_refund",
      created: 1700000700,
    },
  ],
  balance_transactions: [
    {
      id: "txn_test_200",
      account_id: ACCOUNT,
      type: "charge",
      amount: 20000,
      fee: 620,
      net: 19380,
      currency: "usd",
      source_id: "ch_test_200",
      source_type: "charge",
      available_on: 1700086400,
      status: "pending",
      created: 1700000300,
    },
    {
      id: "txn_test_refund",
      account_id: ACCOUNT,
      type: "refund",
      amount: -20000,
      fee: 0,
      net: -20000,
      currency: "usd",
      source_id: "re_test_200",
      source_type: "refund",
      available_on: 1700086400,
      status: "available",
      created: 1700000700,
    },
  ],
};

async function seeded(): Promise<StripeTestApp> {
  const app = await createStripeApp();
  applySeed(app.db, parseSeed(MID_FLOW));
  return app;
}

describe("a flat stripe seed reads back through the twin's own surface", () => {
  it("GET /v1/refunds/:id serves the seeded refund, reason and all", async () => {
    const app = await seeded();
    const { status, body } = await rest(app, "GET", "/v1/refunds/re_test_200");
    expect(status).toBe(200);
    expect(body.id).toBe("re_test_200");
    expect(body.amount).toBe(20000);
    expect(body.reason).toBe("requested_by_customer");
    expect(body.status).toBe("succeeded");
    expect(body.charge).toBe("ch_test_200");
  });

  it("GET /v1/refunds lists it, so a criterion counting refunds sees one", async () => {
    const app = await seeded();
    const { status, body } = await rest(app, "GET", "/v1/refunds");
    expect(status).toBe(200);
    expect((body.data as Array<{ id: string }>).map((row) => row.id)).toEqual(["re_test_200"]);
  });

  it("GET /v1/balance_transactions serves both legs, fee and net intact", async () => {
    const app = await seeded();
    const { status, body } = await rest(app, "GET", "/v1/balance_transactions");
    expect(status).toBe(200);
    const rows = body.data as Array<{ id: string; net: number; fee: number; status: string }>;
    expect(rows.map((row) => row.id).sort()).toEqual(["txn_test_200", "txn_test_refund"]);
    const charge = rows.find((row) => row.id === "txn_test_200")!;
    expect(charge.fee).toBe(620);
    expect(charge.net).toBe(19380);
    // `status` defaults to "available"; the seed asked for "pending" and the
    // world must say "pending".
    expect(charge.status).toBe("pending");
  });

  it("GET /v1/charges/:id reports the charge as fully refunded", async () => {
    const app = await seeded();
    const { status, body } = await rest(app, "GET", "/v1/charges/ch_test_200");
    expect(status).toBe(200);
    expect(body.amount_refunded).toBe(20000);
    // Derived from `amount_refunded >= amount`, so this is the seed showing up
    // in a field the seed never writes.
    expect(body.refunded).toBe(true);
  });

  it("GET /v1/payment_intents/:id keeps the seeded metadata", async () => {
    const app = await seeded();
    const { status, body } = await rest(app, "GET", "/v1/payment_intents/pi_test_200");
    expect(status).toBe(200);
    expect(body.metadata).toEqual({ order_id: "ord_88" });
    expect(body.latest_charge).toBe("ch_test_200");
  });

  // The seed's own consequence, not just its rows: a refund the world already
  // holds is what makes a second one refusable.
  it("a second refund on the fully-refunded charge is refused", async () => {
    const app = await seeded();
    const { status, body } = await rest(app, "POST", "/v1/refunds", { charge: "ch_test_200" });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error?.code).toBe("charge_already_refunded");
  });
});
