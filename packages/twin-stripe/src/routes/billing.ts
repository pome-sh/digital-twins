// SPDX-License-Identifier: Apache-2.0
// Billing REST (M5 warm surfaces, shape tier per the ruling).
//
// Products: POST/GET /v1/products(/:id) · Prices: POST/GET /v1/prices(/:id) ·
// Subscriptions: POST/GET /v1/subscriptions(/:id), POST/DELETE
// /v1/subscriptions/:id · Invoices: GET /v1/invoices(/:id) READS ONLY.
// Everything else in these families (product/price updates, invoice
// create/finalize/pay) stays unlisted-cold on the /v1/* 501 catch-all.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, created, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerBillingRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  // ---------- Products ----------

  declaredRoute(router, STRIPE_ROUTES.createProduct, recorder, runId, ({ body }, c) => {
    const { body: response, delta } = domain.createProduct(accountId(c), body);
    return created(response, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.retrieveProduct, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveProduct(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.listProducts, recorder, runId, ({ query }, c) =>
    ok(domain.listProducts(accountId(c), { ...listQuery(query), active: query.active }))
  );

  // ---------- Prices ----------

  declaredRoute(router, STRIPE_ROUTES.createPrice, recorder, runId, ({ body }, c) => {
    const { body: response, delta } = domain.createPrice(accountId(c), body);
    return created(response, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.retrievePrice, recorder, runId, ({ path }, c) =>
    ok(domain.retrievePrice(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.listPrices, recorder, runId, ({ query }, c) =>
    ok(
      domain.listPrices(accountId(c), {
        ...listQuery(query),
        product: query.product,
        active: query.active,
      })
    )
  );

  // ---------- Subscriptions ----------

  declaredRoute(router, STRIPE_ROUTES.createSubscription, recorder, runId, ({ body }, c) => {
    const { body: response, delta } = domain.createSubscription(accountId(c), body);
    return created(response, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.retrieveSubscription, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveSubscription(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.updateSubscription, recorder, runId, ({ path, body }, c) => {
    const { body: response, delta } = domain.updateSubscription(accountId(c), path.id, body);
    return ok(response, true, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.cancelSubscription, recorder, runId, ({ path }, c) => {
    const { body, delta } = domain.cancelSubscription(accountId(c), path.id);
    return ok(body, true, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.listSubscriptions, recorder, runId, ({ query }, c) =>
    ok(
      domain.listSubscriptions(accountId(c), {
        ...listQuery(query),
        customer: query.customer,
        status: query.status,
      })
    )
  );

  // ---------- Invoices (reads only) ----------

  declaredRoute(router, STRIPE_ROUTES.retrieveInvoice, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveInvoice(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.listInvoices, recorder, runId, ({ query }, c) =>
    ok(domain.listInvoices(accountId(c), listQuery(query)))
  );
}
