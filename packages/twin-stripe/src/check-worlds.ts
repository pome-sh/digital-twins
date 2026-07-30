// SPDX-License-Identifier: Apache-2.0
//
// The fixture worlds Stripe's declarations name (F-1127).
//
// In `src/` rather than `test/` for the same reason twin-github's and
// twin-slack's are: `discriminatingWorlds` is a DECLARED field read from npm by
// pome-cloud and the CLI, so a builder that shipped only in the test tree would
// make the field unusable outside this repo.
//
// ── Why `stripeState` fills every collection ────────────────────────────────
//
// Arm 3 of `probeDiscrimination` rejects a failing world whose reason is the one
// an EMPTY world (`{}`) already gives. Every check here skips on an absent
// collection, so an under-filled fixture reaches `state_incomplete` — which is
// arm 1 and arm 2 territory, not a real verdict. Handing back `[]` for the
// collections a check does not read is therefore load-bearing: it makes the
// difference between the worlds the ASSERTED field, which is exactly what arm 3
// is checking for.
//
// Same shape as twin-slack's `publicChannel`, and for the same reason its
// comment gives: the explicitness is the fixture doing its job, not tidiness.

import type { CheckSubstrate, CheckTapeEvent } from "@pome-sh/sdk/checks";
import type {
  StripeCheckState,
  StripeCheckStateBalanceTransaction,
  StripeCheckStateCharge,
  StripeCheckStateEvent,
  StripeCheckStatePaymentIntent,
  StripeCheckStateRefund,
} from "./check-state.js";

/** Every collection present and empty. Never `{}` — see the header. */
export function stripeState(overrides: StripeCheckState = {}): StripeCheckState {
  return {
    payment_intents: [],
    charges: [],
    balance_transactions: [],
    events: [],
    refunds: [],
    ...overrides,
  };
}

/** A `final`-only world. `seed`/`tape` are null because the engine gives a
 *  `final` check neither, and a fixture richer than the runtime is a fixture
 *  that tests a world the check will never see. */
export function finalWorld(final: StripeCheckState): CheckSubstrate<StripeCheckState> {
  return { seed: null, final, tape: null };
}

/** A `tape` world. `final` is a fully-present but empty account rather than
 *  `{}`: a tape check must not read state, and handing it a shape that would
 *  satisfy a state check hides the difference. */
export function tapeWorld(tape: readonly CheckTapeEvent[]): CheckSubstrate<StripeCheckState> {
  return { seed: null, final: stripeState(), tape };
}

export function paymentIntent(
  overrides: Partial<StripeCheckStatePaymentIntent> = {},
): StripeCheckStatePaymentIntent {
  return {
    id: "pi_test_200",
    amount: 20000,
    currency: "usd",
    status: "succeeded",
    latest_charge: "ch_test_200",
    ...overrides,
  };
}

export function charge(overrides: Partial<StripeCheckStateCharge> = {}): StripeCheckStateCharge {
  return {
    id: "ch_test_200",
    amount: 20000,
    amount_refunded: 0,
    currency: "usd",
    status: "succeeded",
    refunded: false,
    paid: true,
    payment_intent: "pi_test_200",
    balance_transaction: "txn_test_200",
    ...overrides,
  };
}

export function balanceTransaction(
  overrides: Partial<StripeCheckStateBalanceTransaction> = {},
): StripeCheckStateBalanceTransaction {
  // `source` is the PAYMENT INTENT id, not the charge id — the twin's own
  // documented v1 deviation. A fixture that pointed it at the charge would
  // model a world the twin cannot produce.
  return {
    id: "txn_test_200",
    amount: 20000,
    source: "pi_test_200",
    status: "available",
    type: "charge",
    ...overrides,
  };
}

export function event(type: string, overrides: Partial<StripeCheckStateEvent> = {}): StripeCheckStateEvent {
  return { id: `evt_${type.replace(/\W/g, "_")}`, type, data: { object: null }, created: 1700000000, ...overrides };
}

export function refund(overrides: Partial<StripeCheckStateRefund> = {}): StripeCheckStateRefund {
  return {
    id: "re_test_200",
    amount: 7500,
    currency: "usd",
    status: "succeeded",
    charge: "ch_test_200",
    payment_intent: "pi_test_200",
    ...overrides,
  };
}

// ── Tape fixtures ───────────────────────────────────────────────────────────
//
// The engine scopes a tape to the criterion's own twin before a declaration sees
// it (`declared.ts tapeForTwin`), so these carry `twin: "stripe"` for realism
// rather than because any check filters on it.

/** One recorded REST call. */
export function call(overrides: Partial<CheckTapeEvent> = {}): CheckTapeEvent {
  return {
    twin: "stripe",
    method: "GET",
    path: "/s/test-session/v1/refunds",
    status: 200,
    request_body: null,
    tool: null,
    event_id: "evt_call",
    ...overrides,
  };
}

/** One recorded x402 leg. `request_headers` is always PRESENT — an absent map
 *  is the third world `CheckTapeEvent` documents (a recording predating F-1125),
 *  and a fixture that leaves it out tests the pre-header past rather than the
 *  assertion. */
export function x402Leg(overrides: Partial<CheckTapeEvent> = {}): CheckTapeEvent {
  return {
    twin: "stripe",
    method: "GET",
    path: "/s/test-session/x402/protected-resource",
    status: 402,
    request_body: null,
    request_headers: { accept: "application/json" },
    tool: null,
    event_id: "evt_x402",
    ...overrides,
  };
}
