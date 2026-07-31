// SPDX-License-Identifier: Apache-2.0
//
// How a declared check READS the exported Stripe account (F-1127).
//
// pome-cloud kept a hand-maintained mirror of this shape in
// `deterministic/stripe.ts` (`StripeStateTree`, `StripePaymentIntent`,
// `StripeRefund`). That mirror is deleted in the same milestone; this is the
// only model, and it lives next to the export that produces it.
//
// ── One difference from Slack's model, and it changes every field name ──────
//
// Slack's `exportState()` spreads raw SQLite rows. Stripe's does NOT: every
// collection goes through `serializers.ts` first, so what a check reads is the
// STRIPE WIRE OBJECT, not the row. The join columns are the ones that move:
//
//   table column              wire field           what a check must read
//   refunds.charge_id         refund.charge        `charge`
//   refunds.payment_intent_id refund.payment_intent
//   charges.payment_intent_id charge.payment_intent
//   charges.balance_transaction_id
//                             charge.balance_transaction
//   balance_transactions.source_id
//                             balance_transaction.source
//   payment_intents.latest_charge_id
//                             payment_intent.latest_charge
//
// A model written against the SEED schema (`seed.ts`) would carry the `_id`
// names and silently match nothing, which is a positive criterion failing a
// correct agent. The state-shape parity arm in `fidelity-contract.test.ts`
// asserts these names against a real `exportState()` rather than trusting this
// comment.
//
// Every field is optional and every list nullable, for twin-github's and
// twin-slack's reason: an older snapshot or a partial upload arrives here with
// fields absent, and a predicate that assumes presence throws inside the
// evaluator where a NAMED verdict was owed. A criterion may leave the
// denominator; it may never fabricate one (D4).
//
// Three shapes are counter-intuitive and each has a wrong-verdict story:
//   - `charge.refunded` is true only when the charge is FULLY refunded. A
//     partial refund leaves `amount_refunded > 0` and `refunded === false`
//     (`serializers.ts:206-208`). A predicate reading `refunded` to mean "has
//     any refund" misses every partial one — which is the only kind task 14
//     produces.
//   - `balance_transaction.source` points at the PAYMENT INTENT, not the
//     charge, and the domain says so out loud: "real Stripe links the balance
//     txn to the charge, not the PI. Keep it pointed at the PI for now …  OK as
//     v1 deviation" (`domain/stripe-domain.ts`, the crypto-deposit leg). A join
//     written against upstream's semantics finds nothing here.
//   - Every collection is exported `ORDER BY created DESC, rowid DESC` — NEWEST
//     FIRST. `created` has unix-second resolution, so the rowid tiebreak is what
//     makes it deterministic (F-683). Nothing in this vocabulary asserts on
//     order, and that is deliberate: the ordered substrate is the TAPE, and a
//     state check that leaned on export order would be reading an
//     implementation detail the twin is free to change.

export interface StripeCheckStatePaymentIntent {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  latest_charge?: string | null;
}

export interface StripeCheckStateCharge {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  status?: string;
  // FULLY refunded only — see the header. Present for completeness; no check in
  // this vocabulary reads it, because the assertions authors write are about
  // refund ROWS, which `amount_refunded` and the `refunds` collection carry.
  refunded?: boolean;
  paid?: boolean;
  payment_intent?: string | null;
  balance_transaction?: string | null;
}

export interface StripeCheckStateBalanceTransaction {
  id?: string;
  amount?: number;
  // The PAYMENT INTENT id, not the charge id — see the header.
  source?: string | null;
  status?: string;
  type?: string;
}

// `data` carries exactly one key, `object`, holding the full serialized
// resource the event is about (`domain/events.ts` writes
// `JSON.stringify({ object })`). Typed as `unknown` because it is a union of
// every serializer's output and no check in this vocabulary reads inside it —
// asserting on the event TYPE is what the corpus asks for, and reaching into
// `data.object` would re-assert something the `payment_intents` / `charges`
// collections already carry in a shape a check can read.
export interface StripeCheckStateEvent {
  id?: string;
  type?: string;
  data?: { object?: unknown } | null;
  created?: number;
}

export interface StripeCheckStateRefund {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  charge?: string | null;
  payment_intent?: string | null;
}

// The five collections this vocabulary reads. `exportState` emits eleven —
// `customers`, `payment_methods`, `products`, `prices` and `subscriptions` are
// deliberately absent rather than forgotten: no shipped criterion asserts about
// them, and a model field nothing reads is a field nothing keeps honest. They
// join when a check needs them.
export interface StripeCheckState {
  payment_intents?: StripeCheckStatePaymentIntent[] | null;
  charges?: StripeCheckStateCharge[] | null;
  balance_transactions?: StripeCheckStateBalanceTransaction[] | null;
  events?: StripeCheckStateEvent[] | null;
  refunds?: StripeCheckStateRefund[] | null;
}

/** twin-github's and twin-slack's verdict type, same shape and same reason: a
 *  resolver must be able to say WHY it found nothing, because the ways of
 *  finding nothing get different verdicts. */
export type Resolved<T> = { found: T } | { missing: string };

/**
 * The charge a criterion names, with the three outcomes a refund assertion has
 * to tell apart:
 *   - no `charges` key at all → `state_incomplete`; nothing can be attested
 *   - present but this charge absent → `charge_not_found`. A SKIP rather than a
 *     verdict, on twin-slack's `resolveChannel` precedent: we cannot attest a
 *     positive over state we do not have, and for a negative a missing selector
 *     would hand a wrong agent a free pass.
 *   - found → the predicate evaluates. A present charge with zero refunds is a
 *     TRUE vacuous pass for a negative and a TRUE fail for a positive.
 *
 * Comparison is EXACT. A Stripe charge id is an opaque identifier the twin
 * minted, not a human-typed name, so the case-insensitive `#`-tolerant matching
 * twin-slack does for channel names would only widen what a typo can hit.
 */
export function resolveCharge(
  state: StripeCheckState,
  chargeId: string,
): Resolved<StripeCheckStateCharge> {
  if (state.charges == null) return { missing: "state_incomplete" };
  const hit = state.charges.find((charge) => charge.id === chargeId);
  return hit ? { found: hit } : { missing: `charge_not_found ("${chargeId}")` };
}

/**
 * Every refund row against a charge, or the reason we cannot say.
 *
 * Resolves the CHARGE first and skips when it is missing, so "this charge has
 * no refunds" and "there is no such charge" never reach the same verdict —
 * they are the two answers a count assertion must not conflate.
 *
 * An EMPTY list is a real answer, deliberately distinct from either skip: a
 * seeded charge nobody refunded really does have zero refunds.
 */
export function refundsOnCharge(
  state: StripeCheckState,
  chargeId: string,
): Resolved<StripeCheckStateRefund[]> {
  const charge = resolveCharge(state, chargeId);
  if ("missing" in charge) return charge;
  if (state.refunds == null) return { missing: "state_incomplete" };
  return { found: state.refunds.filter((refund) => refund.charge === chargeId) };
}
