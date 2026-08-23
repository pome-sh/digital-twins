// SPDX-License-Identifier: Apache-2.0
// REST routes #11-12.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerEventsRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  declaredRoute(router, STRIPE_ROUTES.retrieveEvent, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveEvent(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.listEvents, recorder, runId, ({ query }, c) =>
    ok(domain.listEvents(accountId(c), { ...listQuery(query), type: query.type }))
  );
}
