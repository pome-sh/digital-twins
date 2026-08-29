// SPDX-License-Identifier: Apache-2.0
// Fidelity contract: the structured inventory is the hub — it must match the live tool
// list exactly, and the FIDELITY.md tables must match the inventory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareToolNames,
  lintFidelityInventory,
  loadFidelityInventory,
} from "@pome-sh/sdk/parity";
import { stripeToolFixture } from "../src/tools.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { StripeDomain } from "../src/domain/index.js";
import { parseSeed } from "../src/seed.js";
import { applySeed } from "../src/apply-seed.js";

const root = resolve(import.meta.dirname, "..");
const inventory = loadFidelityInventory(resolve(root, "fidelity.inventory.json"));
const fidelity = readFileSync(resolve(root, "FIDELITY.md"), "utf8");

describe("Stripe fidelity contract", () => {
  it("keeps fidelity.inventory.json 1:1 with the live tool list", () => {
    expect(
      compareToolNames(
        inventory.tools.map((tool) => tool.name),
        [...stripeToolFixture.toolNames]
      )
    ).toEqual({ missing: [], extra: [] });
  });

  it("keeps the FIDELITY.md tables 1:1 with fidelity.inventory.json", () => {
    expect(
      lintFidelityInventory(inventory, [
        { label: "FIDELITY.md", kind: "tool", markdown: fidelity },
        { label: "FIDELITY.md", kind: "rest", markdown: fidelity },
      ])
    ).toEqual([]);
  });

  it("documents supported REST and x402 product surfaces", () => {
    const matrix = readFileSync(resolve(root, "FIDELITY_MATRIX.md"), "utf8");
    for (const surface of [
      "`POST /v1/payment_intents`",
      "`GET /v1/payment_intents`",
      "`POST /v1/test_helpers/payment_intents/:id/simulate_crypto_deposit`",
      "`GET /x402/protected-resource`"
    ]) {
      expect(matrix).toContain(surface);
    }
    expect(matrix).toContain("Unsupported `/v1/*` paths");
    expect(matrix).toContain("Last verified");
  });
});

// ── idempotency reconciliation ───────────────────────────────────────────────
describe("state-shape parity", () => {
  // Stripe's export runs every collection through `serializers.ts`, so a check
  // reads the WIRE object and join fields lose `_id`. This arm pins that renaming.
  const settledAndRefunded = (): Record<string, unknown> => {
    const db = openTwinStripeDatabase(":memory:");
    applySeed(
      db,
      parseSeed({
        api_keys: [{ key: "sk_test_parity", sid: "parity", account_id: "acct_parity" }],
      }),
    );
    const domain = new StripeDomain(db);
    const created = domain.createPaymentIntent("acct_parity", {
      amount: 20000,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
    }).body as { id: string };
    const settled = domain.simulateCryptoDeposit("acct_parity", created.id).body as {
      latest_charge: string;
    };
    domain.createRefund("acct_parity", { charge: settled.latest_charge, amount: 7500 });
    return domain.exportState("acct_parity") as Record<string, unknown>;
  };

  const rows = (state: Record<string, unknown>, key: string): Record<string, unknown>[] => {
    const list = state[key] as Record<string, unknown>[];
    expect(list?.length, `the parity world produced no ${key} to check the shape against`)
      .toBeGreaterThan(0);
    return list;
  };

  it("finds every top-level key StripeCheckState names", () => {
    const state = settledAndRefunded();
    for (const key of ["payment_intents", "charges", "balance_transactions", "events", "refunds"]) {
      expect(state, `exportState() no longer produces "${key}"`).toHaveProperty(key);
    }
  });

  it("finds every PaymentIntent field the model reads", () => {
    const state = settledAndRefunded();
    for (const field of ["id", "amount", "currency", "status", "latest_charge"]) {
      expect(rows(state, "payment_intents")[0]!, `payment_intents lost "${field}"`).toHaveProperty(
        field,
      );
    }
  });

  it("finds every charge field the model reads, under its WIRE name", () => {
    // `payment_intent` and `balance_transaction`, not `payment_intent_id` /
    // `balance_transaction_id`. This is the renaming above, asserted.
    const state = settledAndRefunded();
    for (const field of [
      "id",
      "amount",
      "amount_refunded",
      "currency",
      "status",
      "refunded",
      "paid",
      "payment_intent",
      "balance_transaction",
    ]) {
      expect(rows(state, "charges")[0]!, `charges lost "${field}"`).toHaveProperty(field);
    }
  });

  it("finds every refund field the model reads, under its WIRE name", () => {
    const state = settledAndRefunded();
    for (const field of ["id", "amount", "currency", "status", "charge", "payment_intent"]) {
      expect(rows(state, "refunds")[0]!, `refunds lost "${field}"`).toHaveProperty(field);
    }
  });

  it("finds every event field the model reads, and confirms `data` holds `object`", () => {
    const state = settledAndRefunded();
    const event = rows(state, "events")[0]!;
    for (const field of ["id", "type", "data", "created"]) {
      expect(event, `events lost "${field}"`).toHaveProperty(field);
    }
    expect(event.data, "an event's `data` no longer carries `object`").toHaveProperty("object");
  });

  it("finds every balance-transaction field the model reads", () => {
    const state = settledAndRefunded();
    for (const field of ["id", "amount", "source", "status", "type"]) {
      expect(rows(state, "balance_transactions")[0]!, `balance_transactions lost "${field}"`)
        .toHaveProperty(field);
    }
  });

  it("confirms `refunded` stays FALSE on a partially-refunded charge", () => {
    // The trap `check-state.ts` documents, and the reason `stripe.refund-exists`
    // reads refund ROWS rather than this flag: `refunded` is true only when a
    // charge is FULLY refunded, and task 14 only ever produces partial ones. If
    // the twin ever changed this, a check reading the flag would start working
    // and the comment would become a lie — so pin the behaviour, not the comment.
    const state = settledAndRefunded();
    const charge = rows(state, "charges")[0]!;
    expect(charge.amount_refunded).toBe(7500);
    expect(charge.refunded).toBe(false);
  });

  it("confirms a balance transaction's `source` points at the PAYMENT INTENT", () => {
    // The twin's own documented v1 deviation — real Stripe links it to the
    // charge. `check-worlds.ts` builds fixtures against the deviation, so if the
    // twin ever corrects it, every fixture modelling a world it can no longer
    // produce fails here rather than passing silently.
    const state = settledAndRefunded();
    const charged = rows(state, "balance_transactions").find((row) => row.type === "charge")!;
    const pi = rows(state, "payment_intents")[0]!;
    expect(charged.source).toBe(pi.id);
  });
});
