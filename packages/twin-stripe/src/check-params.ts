// SPDX-License-Identifier: Apache-2.0
//
// The typed slots Stripe's declared checks fill (F-1127).
//
// They live in the twin, not the sdk, for the same reason the declarations do:
// the twin owns what a Stripe charge id, PaymentIntent status or event type may
// look like. Every pattern is NARROW on purpose — a slot type is what turns "the
// author picked something impossible" into a corrupted instance reported by
// name, rather than a lookup that quietly finds nothing.
//
// ── The closed sets are TYPE-CHECKED against the twin's own unions ───────────
//
// `oneOf` needs a runtime array and a union is not one, so the members are
// written out — but each array carries `satisfies readonly <Union>[]`, so a
// member that is not a real value of that column fails `tsc` here rather than
// binding a sentence nothing can satisfy. That is the half of the drift that
// actually bites: adding a value to the union without adding it here narrows
// what an author may say (visible, and someone complains), while inventing a
// value here would ship a pickable status the twin can never reach (invisible,
// and the criterion just never passes).
//
// All patterns are capture-group-free; `defineCheck` throws otherwise, because
// every consumer reads capture group i+1 as slot i and one smuggled group hands
// each predicate its neighbour's argument.

import { oneOf, type CheckParamType } from "@pome-sh/sdk/checks";
import type { EventType } from "./domain/events.js";
import type { StripeErrorType } from "./errors.js";
import type { ChargeRow, PIStatus } from "./types.js";

// A charge id, as the twin mints it (`ids.ts` → `ch_<random>`) or as a seed
// hand-writes it (`ch_test_200`).
//
// Deliberately WIDER than `ch_[A-Za-z0-9]+`, and the reason is the vacuity
// probe rather than tolerance: `stripe.no-refund-on-charge`'s mutant substitutes
// `VACUITY_SENTINEL` (`pome-vacuity-never`) into this slot, and a mutant that
// does not re-bind measures nothing — it reads as "the verdict moved" and
// blesses the very criterion the probe exists to catch. The hyphen and the
// absent `ch_` prefix are both there for that.
export const chargeId: CheckParamType = {
  name: "charge",
  pattern: "[A-Za-z0-9_-]+",
  example: "ch_test_200",
  render: (value) => value,
  parse: (raw) => raw,
};

// `PIRow.amount` is an integer minor unit — cents for USD. Digits only, no
// separators and no currency symbol: the state carries a number, and a slot that
// accepted "$100.00" would have to decide how to parse it, which is a second
// place for the same fact to live.
//
// Accepts `VACUITY_SENTINEL_NUMBER` (987654321) by construction.
export const minorUnitAmount: CheckParamType = {
  name: "amount",
  pattern: "\\d+",
  example: "10000",
  render: (value) => value,
  parse: (raw) => raw,
};

// A refund row count. Digits, including zero — "the number of refunds … is 0"
// is a legitimate assertion an author may want, and excluding it would push
// them back to prose.
export const rowCount: CheckParamType = {
  name: "count",
  pattern: "\\d+",
  example: "1",
  render: (value) => value,
  parse: (raw) => raw,
};

// `PIStatus` (`types.ts`) — the seven states the payment_intents column can
// hold, which are also upstream Stripe's seven.
const PAYMENT_INTENT_STATUSES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
] as const satisfies readonly PIStatus[];

export const paymentIntentStatus = oneOf("status", PAYMENT_INTENT_STATUSES, "succeeded");

// `ChargeRow["status"]` (`types.ts`). Three, not the PI's seven — a charge is
// created already settled or already declined.
const CHARGE_STATUSES = [
  "pending",
  "succeeded",
  "failed",
] as const satisfies readonly ChargeRow["status"][];

export const chargeStatus = oneOf("status", CHARGE_STATUSES, "succeeded");

// `EventType` (`domain/events.ts`) — every event the twin can append. v1
// delivers no webhooks, so this is also the whole set an examinee can observe by
// polling `GET /v1/events`.
const EVENT_TYPES = [
  "payment_intent.created",
  "payment_intent.requires_action",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.succeeded",
  "charge.failed",
  "charge.refunded",
  "refund.created",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "payment_method.attached",
  "payment_method.detached",
] as const satisfies readonly EventType[];

// The one slot whose rendered form carries no quotes, because the corpus
// already says `payment_intent.succeeded is emitted` and a migration that
// re-renders an existing criterion differently rewrites it. The dot is inside
// the member literals, which `oneOf` escapes — so it matches a dot and not
// "any character".
export const stripeEventType = oneOf("event_type", EVENT_TYPES, "payment_intent.succeeded");

// `StripeErrorType` (`errors.ts`) — the five `error.type` values the twin's
// envelope can carry. Named as a set rather than scanned as free text because
// `type` is the field a Stripe SDK branches on, and an author asserting about a
// value the twin never emits should be stopped at the picker.
const ERROR_TYPES = [
  "invalid_request_error",
  "api_error",
  "card_error",
  "idempotency_error",
  "rate_limit_error",
] as const satisfies readonly StripeErrorType[];

export const stripeErrorType = oneOf("error_type", ERROR_TYPES, "invalid_request_error");
