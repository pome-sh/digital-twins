// SPDX-License-Identifier: Apache-2.0
// REST routes #7-8 from FDRS-270.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerChargesRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  declaredRoute(router, STRIPE_ROUTES.retrieveCharge, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveCharge(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.listCharges, recorder, runId, ({ query }, c) =>
    ok(
      domain.listCharges(accountId(c), {
        ...listQuery(query),
        payment_intent: query.payment_intent,
        customer: query.customer,
      })
    )
  );
}
