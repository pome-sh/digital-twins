// SPDX-License-Identifier: Apache-2.0
//
// The Stripe twin's assertable check vocabulary (milestone A3).
//
// These live HERE, next to the state they read, because the twin owns that
// state's shape. pome-cloud imports this module from npm and adapts each
// declaration onto its predicate engine, so there is no second copy to
// reconcile — only a pin that can fall behind, which is what its drift gate
// exists to catch. The cloud's `deterministic/stripe.ts`, and the mirror of the
// state shape inside it, are deleted in the same milestone.
//
// Stripe is second in A3, after slack, and it is where the milestone's numbers
// actually move. Slack had zero unbound criteria; stripe has eight, spread over
// four tasks whose `[code]` denominator is EMPTY — none of tasks 11, 12, 13 or
// 14 has ever been graded deterministically, not once. Declaring the vocabulary
// is what finds out whether they are good tasks, and for three of them the
// answer required editing the task.
//
// ── What the corpus said, and what it says now ──────────────────────────────
//
// One criterion re-renders BYTE-IDENTICALLY and is not touched:
//
//   payment_intent.succeeded is emitted                         → event-emitted
//
// Six are rewritten, each because the sentence could not be rendered from any
// declaration — not because a template was inconvenient:
//
//   The invalid request returns a Stripe invalid_request_error
//     → A request was rejected with a Stripe "invalid_request_error" error
//     "The invalid request" is a definite reference to something the sentence
//     never identifies.
//
//   A valid PaymentIntent is created after the failure
//     → A PaymentIntent exists with status "requires_action"
//     "valid" names no field. The temporal conjunct is a REAL LOSS and is
//     recorded as one in `docs/grading/stripe-vocabulary.md` rather than
//     quietly dropped: today's vocabulary cannot say that one call preceded
//     another, and the pair of criteria only covers it because an agent that
//     skips the invalid request fails the first one.
//
//   A charge and balance transaction are created for the PaymentIntent
//     → A charge exists with status "succeeded"
//     A conjunction whose second half is a TWIN INVARIANT: both rails write the
//     balance transaction and the succeeded charge inside one SQLite
//     transaction, so no examinee behaviour can produce one without the other.
//     Grading it would have added a criterion that cannot fail while its
//     neighbour passes.
//
//   The first request returns 402 Payment Required
//     → The first x402 request returns 402 Payment Required
//     The predicate is scoped to one surface; the sentence was scoped to
//     nothing.
//
//   At least one refund was successfully issued (a `refund_id` appears in
//     state.refunds or in events.jsonl)
//     → A refund exists on charge "ch_test_200"
//
//   state.refunds.length === 1 — exactly one refund row per logical
//     transaction. CRITICAL: …
//     → The number of refunds on charge "ch_test_200" is 1
//     Prose, a JavaScript expression, and a prediction about the examinee that
//     is FALSE in this twin. All three go.
//
// Two re-render byte-identically and were already bound, by legacy rules this
// milestone replaces: `No refund was attempted on charge "ch_test_200"` (task
// 19) and `The retry includes X-PAYMENT and returns 200` (task 13).
//
// This file is the ASSEMBLY. Declarations are grouped by what they assert about
// — `check-payments.ts`, `check-refunds.ts`, `check-tape.ts` — with typed slots
// in `check-params.ts`, fixture worlds in `check-worlds.ts`, and the reading of
// the exported tree in `check-state.ts`.

import {
  chargeWithStatusExists,
  eventEmitted,
  paymentIntentAmount,
  paymentIntentStatusIs,
  paymentIntentWithStatusExists,
} from "./check-payments.js";
import { refundCount, refundExists } from "./check-refunds.js";
import {
  noRefundOnCharge,
  requestRejectedWithError,
  x402FirstRequestChallenged,
  x402RetryIncludesPayment,
} from "./check-tape.js";

export type { Check } from "./check-kind.js";
export type {
  StripeCheckState,
  StripeCheckStateBalanceTransaction,
  StripeCheckStateCharge,
  StripeCheckStateEvent,
  StripeCheckStatePaymentIntent,
  StripeCheckStateRefund,
} from "./check-state.js";

// Order is not first-match-wins — the generated patterns are anchored and
// mutually exclusive, and `checks-contract.test.ts` proves no sentence is
// claimed by two. It is the order an authoring surface lists them in: the
// state-reading assertions an author reaches for first, then the run-reading
// ones a specialised task needs.
export const STRIPE_CHECKS = [
  paymentIntentAmount,
  paymentIntentStatusIs,
  paymentIntentWithStatusExists,
  chargeWithStatusExists,
  eventEmitted,
  refundExists,
  refundCount,
  // The tape half. Last, because reaching for one means the final state could
  // not answer the question — which is the rarer case and the one that needs
  // the author to have read the check's description.
  noRefundOnCharge,
  requestRejectedWithError,
  x402FirstRequestChallenged,
  x402RetryIncludesPayment,
] as const;
