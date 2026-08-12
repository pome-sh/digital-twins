// SPDX-License-Identifier: Apache-2.0
//
// Spec contract for shape fidelity (FDRS-478 — twin-stripe port of FDRS-475).
//
// This shim anchors the twin's response serializers to Stripe's official
// published TypeScript types (the `stripe` / stripe-node package, devDependency,
// `import type` ONLY — the runtime never imports stripe). The serializers are
// expected to emit a FAITHFUL SUBSET of the upstream schema: omitting fields
// stays legal (DeepPartial makes every field optional), but emitting a
// wrong-named or mistyped field becomes a COMPILE error. This is the
// type-level guard rail — runtime behavior is unchanged.
//
// Since F-1484 the file also carries one INPUT anchor (`STRIPE_REFUND_REASONS`,
// at the bottom). It is a runtime `const` rather than a type, because a
// validator needs the values — but the `stripe` import above stays `import
// type` and is still erased, so nothing here reaches the devDependency at run
// time. The anchoring is done by a type-level assertion beside it.
//
// ANCHOR-LIBRARY-VERSION vs WIRE-VERSION (ST-DIV-012, deliberate decision):
// the anchor pins `stripe@22.2.0` (apiVersion 2026-05-27.dahlia), which is
// DECOUPLED from the wire apiVersion the twin serves (2026-03-04.preview). The
// compile anchor guards SHAPE only; the wire version is tracked by FIDELITY.md +
// live capture. Bumping `stripe` re-runs the anchor (the FDRS-476 bump → tsc →
// decision loop).
import type Stripe from "stripe";

// Each name below is reachable under the `Stripe` namespace (verified against
// node_modules/stripe@22.2.0 — `export declare namespace Stripe` re-exports them).
export type PaymentIntent = Stripe.PaymentIntent;
export type Charge = Stripe.Charge;
export type Refund = Stripe.Refund;
export type BalanceTransaction = Stripe.BalanceTransaction;
export type Balance = Stripe.Balance;
export type Customer = Stripe.Customer;
export type DeletedCustomer = Stripe.DeletedCustomer;
export type PaymentMethod = Stripe.PaymentMethod;
// F-734 warm surfaces (shape tier): the anchor is the shape check for these —
// the serializers emit faithful subsets with no semantic machine behind them.
export type Product = Stripe.Product;
export type Price = Stripe.Price;
// Re-exported from the `Stripe.Price` namespace (a bare type alias can't be
// used as a namespace at the use site).
export type PriceRecurring = Stripe.Price.Recurring;
export type Subscription = Stripe.Subscription;
export type SubscriptionItem = Stripe.SubscriptionItem;

// Stripe's paginated list envelope (object: "list", data, has_more, url). Generic
// over the element type so the twin's `serializedList<T>` anchors against it.
export type ApiList<T> = Stripe.ApiList<T>;

// `Stripe.Event` is a GIANT discriminated union of *Event subtypes — anchoring
// against it would force the serializer to satisfy EVERY member. We anchor the
// twin's generic event serializer against the shared envelope interface
// `Stripe.EventBase` (id / object / api_version / created / livemode /
// pending_webhooks / request), the fields every event carries identically.
export type StripeEvent = Stripe.EventBase;

// Recursive deep-partial: every object property becomes optional and is itself
// deep-partial'd; arrays become Array<DeepPartial<element>>; primitives (and
// function types) pass through unchanged. This is what encodes "faithful
// subset": a serializer may OMIT any field, but a field it DOES emit must
// match the upstream name and (deep-partial) type.
export type DeepPartial<T> = T extends (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// FDRS-476 (phase 2 of FDRS-475) — upstream-added-field guard.
// Uncovered = upstream keys the serializer neither emits nor registers as a
// deliberate omission. When that set is empty the assertion is `true`; when it
// is non-empty the type becomes an error-carrying object whose member type
// NAMES the offending field(s), so a post-`stripe`-bump addition fails tsc by name.
export type AssertNoUncovered<Upstream, Emitted, Allow extends PropertyKey> =
  Exclude<keyof Upstream, keyof Emitted | Allow> extends never
    ? true
    : { __UNCOVERED_UPSTREAM_FIELDS__: Exclude<keyof Upstream, keyof Emitted | Allow> };

// F-1484 — the one INPUT anchor in this file, and the only value set the twin
// closes against the vendor rather than accepting freely.
//
// Both doors that create a refund (`create_refund`'s MCP schema and
// `POST /v1/refunds`'s declared body) validate against this array, so they
// cannot drift apart into a twin that refuses a value over one and accepts it
// over the other.
//
// ⚠️ IT IS `RefundCreateParams.Reason`, NOT `Refund.Reason`. The response union
// carries a FOURTH member — `expired_uncaptured_charge` — that Stripe generates
// internally and REFUSES on input. Anchoring to the object's own reason would
// have re-opened the false pass this closed, one value narrower and just as
// invisible: the twin would accept a create Stripe 400s, and the enum would
// look vendor-derived while being wrong.
export const STRIPE_REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;

// Checked in BOTH directions, and it names the offender the way
// `AssertNoUncovered` does: a `stripe` bump that adds an accepted reason leaves
// it `__MISSING_FROM_TWIN__`, one that removes or renames a reason leaves it
// `__NOT_ACCEPTED_UPSTREAM__`. Either way tsc fails the bump PR by name rather
// than the fidelity lane finding it months later. Asserted `= true` in
// test/upstream-coverage.types.ts, next to the serializer anchors.
export type AssertSameMembers<Declared extends string, Upstream extends string> = [
  Exclude<Upstream, Declared>,
  Exclude<Declared, Upstream>,
] extends [never, never]
  ? true
  : {
      __MISSING_FROM_TWIN__: Exclude<Upstream, Declared>;
      __NOT_ACCEPTED_UPSTREAM__: Exclude<Declared, Upstream>;
    };
