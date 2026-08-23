// SPDX-License-Identifier: Apache-2.0
// REST routes #9-10.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerBalanceRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  declaredRoute(router, STRIPE_ROUTES.retrieveBalance, recorder, runId, (_input, c) =>
    ok(domain.retrieveBalance(accountId(c)))
  );

  declaredRoute(router, STRIPE_ROUTES.listBalanceTransactions, recorder, runId, ({ query }, c) =>
    ok(domain.listBalanceTransactions(accountId(c), { ...listQuery(query), type: query.type }))
  );
}
