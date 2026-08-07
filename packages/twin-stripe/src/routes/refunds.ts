// SPDX-License-Identifier: Apache-2.0
// POST/GET /v1/refunds — FDRS-338 (M3a Lane B).
//
// `created()` carries the canonical state_delta { before: null, after: row }
// through to respond(), which writes it into the recorder event. Idempotency
// is handled upstream by idempotencyMiddleware — a replay with the same key
// short-circuits before this handler runs.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import { STRIPE_ROUTES } from "../route-inputs.js";
import type { Recorder } from "../types.js";
import { accountId, created, declaredRoute, listQuery, ok } from "./_helpers.js";

export function registerRefundsRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  declaredRoute(router, STRIPE_ROUTES.createRefund, recorder, runId, ({ body, header }, c) => {
    const { body: response, delta } = domain.createRefund(accountId(c), {
      // An absent `charge` still reaches the domain, which answers it with
      // Stripe's `parameter_missing`.
      charge: body.charge ?? "",
      amount: body.amount,
      reason: body.reason ?? null,
      idempotency_key: header["Idempotency-Key"] ?? null,
    });
    return created(response, delta);
  });

  declaredRoute(router, STRIPE_ROUTES.retrieveRefund, recorder, runId, ({ path }, c) =>
    ok(domain.retrieveRefund(accountId(c), path.id))
  );

  declaredRoute(router, STRIPE_ROUTES.listRefunds, recorder, runId, ({ query }, c) =>
    ok(
      domain.listRefunds(accountId(c), {
        ...listQuery(query),
        charge: query.charge,
        payment_intent: query.payment_intent,
      })
    )
  );
}
