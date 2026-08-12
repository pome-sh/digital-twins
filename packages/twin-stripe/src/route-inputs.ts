// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — every REST input this twin accepts, declared where it is validated.
//
// Nothing here describes the parse; each entry IS the parse. `declaredRoute()`
// (routes/_helpers.ts) mounts a handler at the method and path its declaration
// carries and hands that handler `declaration.parse()`'s output as its ONLY
// view of the request, so a name that is not below is a name no handler can
// see — and a name below that no route mounts is caught by the 1:1 test.
//
// The body shapes were module-private consts in the route files. Moving them
// here changed nothing about what they accept; it made them readable to the
// artifact emitter and to pome-cloud's declared-fidelity lane, which is the
// whole point. Where this twin's acceptance differs from real Stripe's, the
// declaration states THIS TWIN's truth: reporting the divergence is the lane's
// job, and a declaration bent towards the vendor would hide it.

import { z } from "zod";
import {
  booleanInput,
  bracketedQuery,
  integerInput,
  routeInputDeclarer,
  type RouteInputDeclaration,
} from "@pome-sh/sdk/route-inputs";
import { STRIPE_REFUND_REASONS } from "./upstream-types.js";

/**
 * F-1372 — Stripe refuses a parameter it does not know, so the strict default
 * is affirmed here rather than merely inherited.
 *
 * Stripe's published error-code reference carries `parameter_unknown`: "The
 * request contains one or more unexpected parameters. Remove these and try
 * again." Of the five twins this is the one whose refusal was never in doubt —
 * `routes/errors.ts` already renders `UndeclaredInputError` as
 * `parameter_unknown`, which is to say the twin was speaking Stripe's own word
 * for this before anyone measured whether Stripe says it.
 *
 * Affirmed rather than measured directly: Stripe answers 401 to a request with
 * no API key before it looks at a parameter (measured 2026-08-09), so reaching
 * the validation layer needs a live secret key. `docs/undeclared-route-inputs.md`
 * records the probe and its limit.
 */
const declareInputs = routeInputDeclarer("refuse");

// ─── Shared vocabulary ───────────────────────────────────────────────────────

/** `:id` — every retrieve/update/delete surface in this twin keys on one. */
const ID_PATH = { id: z.string().min(1) } as const;

/**
 * Stripe's standard list pagination + `created` range, on every list surface.
 *
 * `created` is ONE declared input covering the whole `created[gte]=…` family:
 * Stripe's OpenAPI declares one parameter too, so declaring five would report
 * drift that is not real. Each list route flattens it to the `created_*` keys
 * its domain input already takes (`listQuery()` in routes/_helpers.ts).
 */
const LIST_QUERY = {
  limit: integerInput({ min: 1 }).optional(),
  starting_after: z.string().optional(),
  ending_before: z.string().optional(),
  created: bracketedQuery(z.union([z.string(), z.record(z.string(), z.string())]).optional()),
} as const;

/**
 * Metadata on the WRITE surfaces keeps `""` and `null` so the domain can apply
 * Stripe's per-key unset semantics.
 */
const NULLABLE_METADATA = z.record(z.string(), z.string().nullable()).optional();

// ─── Body shapes (were module-private consts in routes/) ─────────────────────

const CREATE_PAYMENT_INTENT_BODY = {
  amount: z.coerce.number().int().positive(),
  currency: z.string().min(1),
  payment_method_types: z.array(z.string()).min(1),
  payment_method_options: z
    .object({
      crypto: z.object({
        mode: z.literal("deposit"),
        deposit_options: z
          .object({ networks: z.array(z.string()).min(1).optional() })
          .optional(),
      }),
    })
    .optional(),
  payment_method: z.string().optional(),
  customer: z.string().optional(),
  confirm: booleanInput.optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  capture_method: z.string().optional(),
  confirmation_method: z.string().optional(),
} as const;

const UPDATE_PAYMENT_INTENT_BODY = {
  amount: z.coerce.number().int().optional(),
  metadata: NULLABLE_METADATA,
  payment_method: z.string().optional(),
  customer: z.string().optional(),
} as const;

const CONFIRM_PAYMENT_INTENT_BODY = { payment_method: z.string().optional() } as const;

/**
 * Refund creation. `amount` is coerced but deliberately NOT constrained to an
 * integer here: `12.5` has to reach the domain, which answers it with Stripe's
 * own `parameter_invalid_integer`. Narrowing it in the declaration would swap
 * that for the generic `parameter_invalid`.
 *
 * `reason` is the opposite call, and F-1484 is why. Stripe's `PostRefunds`
 * declares it as a CLOSED set — `["duplicate","fraudulent",
 * "requested_by_customer"]`, the same three its MCP `create_refund` declares —
 * so a free string here is a request real Stripe answers 400 and this twin
 * answered 200. `.nullish()` is kept deliberately: the tightening narrows the
 * VALUE, not the arity. Stripe does not require the field, and every refund the
 * corpus actually makes omits it.
 */
const CREATE_REFUND_BODY = {
  charge: z.string().optional(),
  amount: z.coerce.number().optional(),
  reason: z.enum(STRIPE_REFUND_REASONS).nullish(),
} as const;

/** Every customer field is optional, like real Stripe's. */
const CUSTOMER_FIELDS_BODY = {
  name: z.string().nullish(),
  email: z.string().nullish(),
  description: z.string().nullish(),
  phone: z.string().nullish(),
  metadata: NULLABLE_METADATA,
} as const;

/**
 * Payment-method creation is the one write whose VALIDATION is the domain's,
 * because the domain answers with Stripe's own `parameter_missing` /
 * `card_error` codes and their `param` paths (`card[exp_month]`). So the
 * schemas here are `z.unknown()`: the declaration's job on this route is
 * naming — plus refusing a name the twin does not accept — and a tighter
 * schema would replace those codes with `parameter_invalid`.
 *
 * The set is `type` and `card`, which is exactly `CreatePaymentMethodInput`.
 * `billing_details` and the rest of real Stripe's create surface are NOT here:
 * the twin reads neither, and declaring an input it ignores is the failure mode
 * this whole mechanism exists to prevent.
 */
const CREATE_PAYMENT_METHOD_BODY = {
  type: z.unknown().optional(),
  card: z.unknown().optional(),
} as const;

const PRODUCT_FIELDS_BODY = {
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
  active: booleanInput.optional(),
  metadata: NULLABLE_METADATA,
} as const;

const CREATE_PRICE_BODY = {
  currency: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  unit_amount: z.coerce.number().int().nonnegative().optional(),
  recurring: z
    .object({
      interval: z.string().min(1),
      interval_count: z.coerce.number().int().positive().optional(),
    })
    .optional(),
  nickname: z.string().nullish(),
  lookup_key: z.string().nullish(),
  active: booleanInput.optional(),
  metadata: NULLABLE_METADATA,
} as const;

const CREATE_SUBSCRIPTION_BODY = {
  customer: z.string().min(1).optional(),
  items: z
    .array(
      z.object({
        price: z.string().min(1).optional(),
        quantity: z.coerce.number().int().positive().optional(),
      })
    )
    .optional(),
  cancel_at_period_end: booleanInput.optional(),
  metadata: NULLABLE_METADATA,
} as const;

const UPDATE_SUBSCRIPTION_BODY = {
  cancel_at_period_end: booleanInput.optional(),
  metadata: NULLABLE_METADATA,
} as const;

// ─── The routes ──────────────────────────────────────────────────────────────

export const STRIPE_ROUTES = {
  // ---------- PaymentIntents ----------

  createPaymentIntent: declareInputs({
    method: "POST",
    path: "/v1/payment_intents",
    bodyEncoding: "form",
    body: CREATE_PAYMENT_INTENT_BODY,
  }),

  retrievePaymentIntent: declareInputs({
    method: "GET",
    path: "/v1/payment_intents/:id",
    pathParams: ID_PATH,
  }),

  listPaymentIntents: declareInputs({
    method: "GET",
    path: "/v1/payment_intents",
    query: LIST_QUERY,
  }),

  confirmPaymentIntent: declareInputs({
    method: "POST",
    path: "/v1/payment_intents/:id/confirm",
    pathParams: ID_PATH,
    bodyEncoding: "form",
    body: CONFIRM_PAYMENT_INTENT_BODY,
  }),

  updatePaymentIntent: declareInputs({
    method: "POST",
    path: "/v1/payment_intents/:id",
    pathParams: ID_PATH,
    bodyEncoding: "form",
    body: UPDATE_PAYMENT_INTENT_BODY,
  }),

  // Cancellation takes no body at all here. Real Stripe accepts
  // `cancellation_reason`; this twin has never read it, so it is not declared.
  cancelPaymentIntent: declareInputs({
    method: "POST",
    path: "/v1/payment_intents/:id/cancel",
    pathParams: ID_PATH,
  }),

  simulateCryptoDeposit: declareInputs({
    method: "POST",
    path: "/v1/test_helpers/payment_intents/:id/simulate_crypto_deposit",
    pathParams: ID_PATH,
  }),

  // ---------- Charges ----------

  retrieveCharge: declareInputs({
    method: "GET",
    path: "/v1/charges/:id",
    pathParams: ID_PATH,
  }),

  listCharges: declareInputs({
    method: "GET",
    path: "/v1/charges",
    query: { ...LIST_QUERY, payment_intent: z.string().optional(), customer: z.string().optional() },
  }),

  // ---------- Refunds ----------

  createRefund: declareInputs({
    method: "POST",
    path: "/v1/refunds",
    // A real declared input on this route: the handler reads it and the domain
    // stores it on the refund. Undeclared headers are ignored rather than
    // refused, so the engine's own (`Authorization`, `Stripe-Account`) need no
    // entry here — they are not this route's inputs.
    headers: { "Idempotency-Key": z.string().optional() },
    bodyEncoding: "form",
    body: CREATE_REFUND_BODY,
  }),

  retrieveRefund: declareInputs({
    method: "GET",
    path: "/v1/refunds/:id",
    pathParams: ID_PATH,
  }),

  listRefunds: declareInputs({
    method: "GET",
    path: "/v1/refunds",
    query: { ...LIST_QUERY, charge: z.string().optional(), payment_intent: z.string().optional() },
  }),

  // ---------- Customers ----------

  createCustomer: declareInputs({
    method: "POST",
    path: "/v1/customers",
    bodyEncoding: "form",
    body: CUSTOMER_FIELDS_BODY,
  }),

  // F-1389 (ST-DECL-IN-001) — NOT `LIST_QUERY`. This is the one list surface
  // that does not take `created`: `GetCustomersCustomerPaymentMethods` declares
  // `allow_redisplay, ending_before, expand, limit, starting_after, type` and
  // nothing else, and Stripe's measured disposition is `refuse` — it publishes
  // `parameter_unknown`. Sharing `LIST_QUERY` here meant a request Stripe
  // rejects outright succeeded, so an exam scored a call the real API declined.
  // Leaving it undeclared is what makes the twin refuse it too: the declaration
  // IS the validator, and this twin's declarer is `refuse`. That is why this
  // one is spelled out rather than fixed by spreading a narrower shared shape —
  // the point is the absence, and a future `LIST_QUERY` edit must not put
  // `created` back by inheritance.
  listCustomerPaymentMethods: declareInputs({
    method: "GET",
    path: "/v1/customers/:id/payment_methods",
    pathParams: ID_PATH,
    query: {
      limit: LIST_QUERY.limit,
      starting_after: LIST_QUERY.starting_after,
      ending_before: LIST_QUERY.ending_before,
      type: z.string().optional(),
    },
  }),

  retrieveCustomer: declareInputs({
    method: "GET",
    path: "/v1/customers/:id",
    pathParams: ID_PATH,
  }),

  updateCustomer: declareInputs({
    method: "POST",
    path: "/v1/customers/:id",
    pathParams: ID_PATH,
    bodyEncoding: "form",
    body: CUSTOMER_FIELDS_BODY,
  }),

  deleteCustomer: declareInputs({
    method: "DELETE",
    path: "/v1/customers/:id",
    pathParams: ID_PATH,
  }),

  listCustomers: declareInputs({
    method: "GET",
    path: "/v1/customers",
    query: { ...LIST_QUERY, email: z.string().optional() },
  }),

  // ---------- Payment methods ----------

  createPaymentMethod: declareInputs({
    method: "POST",
    path: "/v1/payment_methods",
    bodyEncoding: "form",
    body: CREATE_PAYMENT_METHOD_BODY,
  }),

  retrievePaymentMethod: declareInputs({
    method: "GET",
    path: "/v1/payment_methods/:id",
    pathParams: ID_PATH,
  }),

  attachPaymentMethod: declareInputs({
    method: "POST",
    path: "/v1/payment_methods/:id/attach",
    pathParams: ID_PATH,
    bodyEncoding: "form",
    body: { customer: z.string().optional() },
  }),

  detachPaymentMethod: declareInputs({
    method: "POST",
    path: "/v1/payment_methods/:id/detach",
    pathParams: ID_PATH,
  }),

  // ---------- Products ----------

  createProduct: declareInputs({
    method: "POST",
    path: "/v1/products",
    bodyEncoding: "form",
    body: PRODUCT_FIELDS_BODY,
  }),

  retrieveProduct: declareInputs({
    method: "GET",
    path: "/v1/products/:id",
    pathParams: ID_PATH,
  }),

  listProducts: declareInputs({
    method: "GET",
    path: "/v1/products",
    query: { ...LIST_QUERY, active: booleanInput.optional() },
  }),

  // ---------- Prices ----------

  createPrice: declareInputs({
    method: "POST",
    path: "/v1/prices",
    bodyEncoding: "form",
    body: CREATE_PRICE_BODY,
  }),

  retrievePrice: declareInputs({
    method: "GET",
    path: "/v1/prices/:id",
    pathParams: ID_PATH,
  }),

  listPrices: declareInputs({
    method: "GET",
    path: "/v1/prices",
    query: { ...LIST_QUERY, product: z.string().optional(), active: booleanInput.optional() },
  }),

  // ---------- Subscriptions ----------

  createSubscription: declareInputs({
    method: "POST",
    path: "/v1/subscriptions",
    bodyEncoding: "form",
    body: CREATE_SUBSCRIPTION_BODY,
  }),

  retrieveSubscription: declareInputs({
    method: "GET",
    path: "/v1/subscriptions/:id",
    pathParams: ID_PATH,
  }),

  updateSubscription: declareInputs({
    method: "POST",
    path: "/v1/subscriptions/:id",
    pathParams: ID_PATH,
    bodyEncoding: "form",
    body: UPDATE_SUBSCRIPTION_BODY,
  }),

  cancelSubscription: declareInputs({
    method: "DELETE",
    path: "/v1/subscriptions/:id",
    pathParams: ID_PATH,
  }),

  listSubscriptions: declareInputs({
    method: "GET",
    path: "/v1/subscriptions",
    query: { ...LIST_QUERY, customer: z.string().optional(), status: z.string().optional() },
  }),

  // ---------- Invoices (reads only) ----------

  retrieveInvoice: declareInputs({
    method: "GET",
    path: "/v1/invoices/:id",
    pathParams: ID_PATH,
  }),

  listInvoices: declareInputs({
    method: "GET",
    path: "/v1/invoices",
    query: LIST_QUERY,
  }),

  // ---------- Balance ----------

  retrieveBalance: declareInputs({
    method: "GET",
    path: "/v1/balance",
  }),

  listBalanceTransactions: declareInputs({
    method: "GET",
    path: "/v1/balance_transactions",
    query: { ...LIST_QUERY, type: z.string().optional() },
  }),

  // ---------- Events ----------

  retrieveEvent: declareInputs({
    method: "GET",
    path: "/v1/events/:id",
    pathParams: ID_PATH,
  }),

  listEvents: declareInputs({
    method: "GET",
    path: "/v1/events",
    query: { ...LIST_QUERY, type: z.string().optional() },
  }),
} as const;

/** Every REST route this twin serves. Read by the artifact emitter and the 1:1 test. */
export const STRIPE_ROUTE_INPUTS: readonly RouteInputDeclaration[] = Object.values(STRIPE_ROUTES);
