// SPDX-License-Identifier: Apache-2.0
// REST routes #1-6 from FDRS-270.
//
// Every input each route accepts is declared in ../route-inputs.ts; the body
// schemas that used to be module-private consts here moved there unchanged.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, created, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerPaymentIntentRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  // 1. POST /v1/payment_intents
  declaredRoute(router, STRIPE_ROUTES.createPaymentIntent, recorder, runId, ({ body }, c) => {
    const { body: piBody, delta } = domain.createPaymentIntent(accountId(c), body);
    return created(piBody, delta);
  });

  // 2. GET /v1/payment_intents/:id
  declaredRoute(router, STRIPE_ROUTES.retrievePaymentIntent, recorder, runId, ({ path }, c) =>
    ok(domain.retrievePaymentIntent(accountId(c), path.id))
  );

  // 3. GET /v1/payment_intents
  declaredRoute(router, STRIPE_ROUTES.listPaymentIntents, recorder, runId, ({ query }, c) =>
    ok(domain.listPaymentIntents(accountId(c), listQuery(query)))
  );

  // 4. POST /v1/payment_intents/:id/confirm
  declaredRoute(router, STRIPE_ROUTES.confirmPaymentIntent, recorder, runId, ({ path, body }, c) => {
    const { body: piBody, delta } = domain.confirmPaymentIntent(accountId(c), path.id, body);
    return ok(piBody, true, delta);
  });

  // 4b. POST /v1/payment_intents/:id — update (F-731, the retry-with-new-PM step)
  declaredRoute(router, STRIPE_ROUTES.updatePaymentIntent, recorder, runId, ({ path, body }, c) => {
    const { body: piBody, delta } = domain.updatePaymentIntent(accountId(c), path.id, body);
    return ok(piBody, true, delta);
  });

  // 5. POST /v1/payment_intents/:id/cancel
  declaredRoute(router, STRIPE_ROUTES.cancelPaymentIntent, recorder, runId, ({ path }, c) => {
    const { body, delta } = domain.cancelPaymentIntent(accountId(c), path.id);
    return ok(body, true, delta);
  });

  // 6. POST /v1/test_helpers/payment_intents/:id/simulate_crypto_deposit
  declaredRoute(router, STRIPE_ROUTES.simulateCryptoDeposit, recorder, runId, ({ path }, c) => {
    const { body, delta } = domain.simulateCryptoDeposit(accountId(c), path.id);
    return ok(body, true, delta);
  });
}
