// SPDX-License-Identifier: Apache-2.0
//
// The WRITE half of the stripe seed: `applySeed` and the raw row inserts it
// drives. Split out of `seed.ts` so that module is the zod-only leaf every other
// twin's already is — and that `registry.ts`'s own header and
// `scripts/lint/rules/twin-chunks.mjs`'s own failure message have both told
// readers it was:
//
//     "If all you need is a seed schema or a default world, import the twin's
//      `/seed` subpath — it is a zod-only leaf."
//
// For stripe that was FALSE. `seed.ts` imported `./domain/schema.js` for
// `ensureStripeTables` and `./api-keys.js` for `mintApiKey`, so naming
// `@pome-sh/twin-stripe/seed` from CLI source put stripe's domain in the graph
// `pome --version` loads, and `twin-chunks` red. That is why the task parser
// carried a hand-written stripe mirror at all (F-584), and why the mirror could
// not simply be deleted the way github's was (F-581).
//
// `applySeed` keeps its NAME and its package-root export
// (`@pome-sh/twin-stripe`), which is the door `@pome-sh/sandbox-domains/stripe`
// already reaches `StripeDomain` and `openTwinStripeDatabase` through — so that
// package's published surface does not move. What moves is one import line
// there, and the fact that `/seed` now means "schemas and a default world",
// nothing else.
import { mintApiKey } from "./api-keys.js";
import { ensureStripeTables } from "./domain/schema.js";
import type { FailureInjectionStore } from "@pome-sh/sdk/failure-injection-rules";
import type {
  BalanceTransactionSeed,
  ChargeSeed,
  PaymentIntentSeed,
  RefundSeed,
} from "./seed.js";
import type { SeedState, TwinStripeDatabase } from "./types.js";

export function applySeed(
  db: TwinStripeDatabase,
  seed: SeedState,
  failureInjection?: FailureInjectionStore
): void {
  // Ensure Stripe domain tables exist before inserting prerequisite rows.
  // Mirrors what each Domain class does in its constructor; harmless when
  // already migrated.
  ensureStripeTables(db);

  for (const entry of seed.api_keys ?? []) {
    mintApiKey(db, {
      sid: entry.sid,
      account_id: entry.account_id,
      key: entry.key
    });
  }
  for (const row of seed.payment_intents ?? []) {
    insertSeedPaymentIntent(db, row);
  }
  for (const row of seed.charges ?? []) {
    insertSeedCharge(db, row);
  }
  for (const row of seed.balance_transactions ?? []) {
    insertSeedBalanceTransaction(db, row);
  }
  for (const row of seed.refunds ?? []) {
    insertSeedRefund(db, row);
  }
  if (failureInjection) {
    failureInjection.setRules(seed.failure_injection ?? []);
  }
}

// ---------- raw row inserts ----------
//
// These bypass the domain classes' business rules (PI state machine, charge
// minting invariants, refund atomic transaction, etc.) and write directly to
// the tables defined in `domain/schema.ts`. The point is that the rows must
// be read back via the same domain helpers and serializers the live handlers
// use, with no observable difference from agent-created rows.

function insertSeedPaymentIntent(
  db: TwinStripeDatabase,
  row: PaymentIntentSeed
): void {
  db.prepare(
    `INSERT INTO payment_intents (
      id, account_id, amount, currency, status,
      payment_method_types_json, next_action_json,
      latest_charge_id, capture_method, confirmation_method,
      idempotency_key, metadata_json, crypto_deposit_json,
      client_secret, created, updated, canceled_at, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.amount,
    row.currency,
    row.status,
    JSON.stringify(row.payment_method_types),
    row.next_action === undefined || row.next_action === null
      ? null
      : JSON.stringify(row.next_action),
    row.latest_charge_id ?? null,
    row.capture_method,
    row.confirmation_method,
    row.idempotency_key ?? null,
    JSON.stringify(row.metadata),
    row.crypto_deposit === undefined || row.crypto_deposit === null
      ? null
      : JSON.stringify(row.crypto_deposit),
    row.client_secret,
    row.created,
    row.updated,
    row.canceled_at ?? null,
    row.captured_at ?? null
  );
}

function insertSeedCharge(db: TwinStripeDatabase, row: ChargeSeed): void {
  db.prepare(
    `INSERT INTO charges (
      id, account_id, payment_intent_id, amount, amount_captured, amount_refunded,
      status, balance_transaction_id, captured, currency, created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.payment_intent_id,
    row.amount,
    row.amount_captured,
    row.amount_refunded,
    row.status,
    row.balance_transaction_id ?? null,
    row.captured ? 1 : 0,
    row.currency,
    row.created
  );
}

function insertSeedRefund(db: TwinStripeDatabase, row: RefundSeed): void {
  db.prepare(
    `INSERT INTO refunds (
      id, account_id, charge_id, payment_intent_id, amount, currency,
      status, reason, balance_transaction_id, idempotency_key, created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.charge_id,
    row.payment_intent_id,
    row.amount,
    row.currency,
    row.status,
    row.reason ?? null,
    row.balance_transaction_id ?? null,
    row.idempotency_key ?? null,
    row.created
  );
}

function insertSeedBalanceTransaction(
  db: TwinStripeDatabase,
  row: BalanceTransactionSeed
): void {
  db.prepare(
    `INSERT INTO balance_transactions (
      id, account_id, type, amount, fee, net, currency, source_id, source_type,
      available_on, status, created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.type,
    row.amount,
    row.fee,
    row.net,
    row.currency,
    row.source_id ?? null,
    row.source_type ?? null,
    row.available_on,
    row.status,
    row.created
  );
}
