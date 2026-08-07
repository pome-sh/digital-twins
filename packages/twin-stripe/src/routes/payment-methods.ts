// SPDX-License-Identifier: Apache-2.0
// Payment methods REST — F-732 (M5 card-on-file chain).
//
// POST /v1/payment_methods · GET /v1/payment_methods/:id ·
// POST /v1/payment_methods/:id/attach|detach. The top-level list
// (GET /v1/payment_methods) stays on the loud-501 surface per the F-729
// ruling — the customer-scoped list is the hot read.

import type { Hono } from "hono";
import type { CreatePaymentMethodInput, StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { TwinError } from "../errors.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import { accountId, created, declaredRoute, ok } from "./_helpers.js";

export function registerPaymentMethodsRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  declaredRoute(router, STRIPE_ROUTES.createPaymentMethod, recorder, runId, ({ body }, c) => {
    // The declaration names `type` and `card` but leaves their VALUES unchecked:
    // validation lives in the domain, which answers with Stripe's own
    // parameter_missing / card_error codes and their `card[exp_month]` params.
    const { body: response, delta } = domain.createPaymentMethod(
      accountId(c),
      body as CreatePaymentMethodInput
    );
    return created(response, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.retrievePaymentMethod, recorder, runId, ({ path }, c) =>
    ok(domain.retrievePaymentMethod(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.attachPaymentMethod, recorder, runId, ({ path, body }, c) => {
    if (!body.customer) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_missing",
        "Missing required param: customer.",
        { param: "customer", statusCode: 400 }
      );
    }
    const { body: response, delta } = domain.attachPaymentMethod(
      accountId(c),
      path.id,
      body.customer
    );
    return ok(response, true, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.detachPaymentMethod, recorder, runId, ({ path }, c) => {
    const { body, delta } = domain.detachPaymentMethod(accountId(c), path.id);
    return ok(body, true, delta);
  });
}
