// SPDX-License-Identifier: Apache-2.0
// Customers REST — F-732 (M5 customer-management hot path).
//
// POST /v1/customers · GET /v1/customers(/:id) · POST /v1/customers/:id ·
// DELETE /v1/customers/:id · GET /v1/customers/:id/payment_methods.
// Idempotency is handled upstream by idempotencyMiddleware; every mutation
// carries the canonical state_delta through to respond().

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, created, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerCustomersRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  declaredRoute(router, STRIPE_ROUTES.createCustomer, recorder, runId, ({ body }, c) => {
    const { body: response, delta } = domain.createCustomer(accountId(c), body);
    return created(response, delta);
  });

  declaredRoute(
    router,
    STRIPE_ROUTES.listCustomerPaymentMethods,
    recorder,
    runId,
    ({ path, query }, c) =>
      ok(
        domain.listCustomerPaymentMethods(accountId(c), path.id, {
          ...listQuery(query),
          type: query.type,
        })
      )
  );

  declaredRoute(router, STRIPE_ROUTES.retrieveCustomer, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveCustomer(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.updateCustomer, recorder, runId, ({ path, body }, c) => {
    const { body: response, delta } = domain.updateCustomer(accountId(c), path.id, body);
    return ok(response, true, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.deleteCustomer, recorder, runId, ({ path }, c) => {
    const { body, delta } = domain.deleteCustomer(accountId(c), path.id);
    return ok(body, true, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.listCustomers, recorder, runId, ({ query }, c) =>
    ok(domain.listCustomers(accountId(c), { ...listQuery(query), email: query.email }))
  );
}
