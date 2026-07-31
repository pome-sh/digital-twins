// SPDX-License-Identifier: Apache-2.0
//
// F-1138 — `after_handler` failure injection must not eat the Idempotency-Key
// record.
//
// The mode models "the server processed it, but response delivery to the client
// failed." Real Stripe writes the idempotency record server-side in exactly
// that situation, which is the entire reason the header exists: a retry replays
// rather than re-executing. The twin used to persist the refund and drop the
// key — the half of the failure that hurts and none of the half that protects —
// so an agent doing the textbook-correct thing still over-refunded, and task 14
// failed it for a reason that was the twin's rather than the agent's.
//
// The measurement in the last describe is the probe F-1127 used while grading
// the stripe corpus, promoted out of that branch's design doc into the test
// tree. The seed mirrors `cli/tasks/14-stripe-refund-retry.md` verbatim with one
// deliberate edit: every `account_id` is retargeted at the harness session's
// account, because the JWT resolves to `acct_test-session` and a mismatch reads
// as an empty `/_pome/state` rather than as an error. Reaching into `cli/tasks/`
// from here would invert the dependency, so the seed is mirrored and this
// comment is the pin.

import { describe, expect, it } from "vitest";
import {
  createStripeApp,
  rest,
  TEST_ACCOUNT_ID,
  type StripeTestApp,
} from "./_appHelper.js";
import type { IdempotencyKeyRow } from "../src/types.js";

const CHARGE_ID = "ch_test_200";
const REFUND_BODY = { charge: CHARGE_ID, amount: 7500 };

const LOST_RESPONSE_RULE = {
  method: "POST",
  path: "/v1/refunds",
  attempt: 1,
  mode: "after_handler" as const,
  status: 402,
  body: {
    error: {
      type: "card_error",
      code: "card_declined",
      message:
        "Simulated lost-response failure: refund persisted server-side, but response delivery to the client failed.",
    },
  },
};

const TASK_14_WORLD = {
  payment_intents: [
    {
      id: "pi_test_200",
      account_id: TEST_ACCOUNT_ID,
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      client_secret: "pi_test_200_secret",
      latest_charge_id: CHARGE_ID,
      capture_method: "automatic",
      confirmation_method: "automatic",
      payment_method_types: ["crypto"],
      created: 1700000000,
      updated: 1700000000,
      captured_at: 1700000000,
    },
  ],
  charges: [
    {
      id: CHARGE_ID,
      account_id: TEST_ACCOUNT_ID,
      payment_intent_id: "pi_test_200",
      amount: 20000,
      amount_captured: 20000,
      amount_refunded: 0,
      status: "succeeded",
      currency: "usd",
      captured: true,
      created: 1700000000,
    },
  ],
};

/** Seed task 14's world. `inject: false` is the control arm — same world, no rule. */
async function seedTask14(
  app: StripeTestApp,
  { inject = true }: { inject?: boolean } = {}
) {
  const res = await app.app.request("/admin/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...TASK_14_WORLD,
      failure_injection: inject ? [LOST_RESPONSE_RULE] : [],
    }),
  });
  if (res.status !== 200) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
}

function refund(app: StripeTestApp, headers: Record<string, string> = {}) {
  return rest(app, "POST", "/v1/refunds", REFUND_BODY, headers);
}

async function refundRows(app: StripeTestApp): Promise<Array<Record<string, unknown>>> {
  const state = await rest(app, "GET", "/_pome/state");
  return (state.body.refunds ?? []) as Array<Record<string, unknown>>;
}

function idempotencyRows(app: StripeTestApp): IdempotencyKeyRow[] {
  return app.db
    .prepare("SELECT * FROM idempotency_keys")
    .all() as unknown as IdempotencyKeyRow[];
}

async function refundPostEvents(app: StripeTestApp) {
  const events = (await rest(app, "GET", "/_pome/events")).body as Array<
    Record<string, unknown>
  >;
  return events.filter(
    (e) =>
      e.method === "POST" &&
      typeof e.path === "string" &&
      (e.path as string).endsWith("/v1/refunds")
  );
}

describe("F-1138 — after_handler keeps the Idempotency-Key record", () => {
  it("writes one idempotency row carrying the handler's real 200, not the injected 402", async () => {
    const app = await createStripeApp();
    await seedTask14(app);

    const first = await refund(app, { "Idempotency-Key": "refund_retry_1" });
    expect(first.status).toBe(402);

    const rows = idempotencyRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.response_status).toBe(200);
    expect(rows[0]!.key).toBe("refund_retry_1");
    expect(rows[0]!.method).toBe("POST");
    // The cached body is the refund the handler actually created, so a replay
    // can hand the client the object it never saw.
    const cached = JSON.parse(rows[0]!.response_body_json) as Record<string, unknown>;
    expect(cached.object).toBe("refund");
    expect(cached.charge).toBe(CHARGE_ID);
    expect(cached.amount).toBe(7500);
  });

  it("the retry under the same key replays instead of refunding twice", async () => {
    const app = await createStripeApp();
    await seedTask14(app);
    const headers = { "Idempotency-Key": "refund_retry_2" };

    const first = await refund(app, headers);
    expect(first.status).toBe(402);
    const retry = await refund(app, headers);

    expect(retry.status).toBe(200);
    expect(retry.body.object).toBe("refund");
    const rows = await refundRows(app);
    expect(rows).toHaveLength(1);
    expect(retry.body.id).toBe(rows[0]!.id);
    const charge = await rest(app, "GET", `/v1/charges/${CHARGE_ID}`);
    expect(charge.body.amount_refunded).toBe(7500);
  });

  it("the replay is recorded as a dedupe, so the tape shows why the retry was free", async () => {
    const app = await createStripeApp();
    await seedTask14(app);
    const headers = { "Idempotency-Key": "refund_retry_3" };

    await refund(app, headers);
    await refund(app, headers);

    const posts = await refundPostEvents(app);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      status: 200,
      idempotency_dedupe: true,
      state_mutation: false,
      state_delta: null,
    });
  });

  it("still delivers the injected 402 on the wire and records it with the real mutation", async () => {
    const app = await createStripeApp();
    await seedTask14(app);

    const first = await refund(app, { "Idempotency-Key": "refund_retry_4" });

    expect(first.status).toBe(402);
    expect(first.body.error.code).toBe("card_declined");
    const posts = await refundPostEvents(app);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ status: 402, state_mutation: true });
    expect(
      (posts[0]!.response_body as { error: { code: string } }).error.code
    ).toBe("card_declined");
    const delta = posts[0]!.state_delta as { before: unknown; after: Record<string, unknown> };
    expect(delta.before).toBeNull();
    expect(delta.after).toMatchObject({ charge_id: CHARGE_ID, amount: 7500 });
  });
});

describe("F-1138 — the properties the fix had to keep", () => {
  // The ordering comment in twin.ts: injection runs OUTSIDE idempotency so a
  // configured `before_handler` failure is produced where the cache cannot see
  // it. Caching it would replay the synthetic 4xx forever.
  it("before_handler is still never cached — the retry re-invokes the handler", async () => {
    const app = await createStripeApp();
    const res = await app.app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...TASK_14_WORLD,
        failure_injection: [{ ...LOST_RESPONSE_RULE, mode: "before_handler" }],
      }),
    });
    expect(res.status).toBe(200);
    const headers = { "Idempotency-Key": "before_handler_key" };

    const first = await refund(app, headers);
    expect(first.status).toBe(402);
    expect(idempotencyRows(app)).toHaveLength(0);

    const retry = await refund(app, headers);
    expect(retry.status).toBe(200);
    expect(await refundRows(app)).toHaveLength(1);
  });

  // F5: real Stripe re-executes on a client 4xx, so the twin must not cache one.
  // The refund route reaches its 4xx through the same `respond()` the injected
  // 402 travels, which is why this arm is here and not only in idempotency.test.
  it("a genuine 4xx from the refund handler is still not cached", async () => {
    const app = await createStripeApp();
    await seedTask14(app, { inject: false });
    const headers = { "Idempotency-Key": "no_such_charge" };

    const first = await rest(app, "POST", "/v1/refunds", { charge: "ch_nope", amount: 100 }, headers);
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(idempotencyRows(app)).toHaveLength(0);

    const retry = await rest(app, "POST", "/v1/refunds", { charge: "ch_nope", amount: 100 }, headers);
    expect(retry.status).toBe(first.status);
    expect(idempotencyRows(app)).toHaveLength(0);
  });
});

// The five archetypes F-1127 measured against task 14's real seed. The table is
// the point: the criterion `The number of refunds on charge "ch_test_200" is 1`
// must separate an agent that protects the retry from one that does not, and
// before F-1138 the CAREFUL row read 2 — identical to CARELESS, which made the
// header decorative.
describe("F-1138 — task 14 criterion discrimination", () => {
  it("NULL: an agent that does nothing leaves zero refunds", async () => {
    const app = await createStripeApp();
    await seedTask14(app);
    expect(await refundRows(app)).toHaveLength(0);
  });

  it("CARELESS: no Idempotency-Key, retries the 402 → two refunds", async () => {
    const app = await createStripeApp();
    await seedTask14(app);

    expect((await refund(app)).status).toBe(402);
    expect((await refund(app)).status).toBe(200);

    expect(await refundRows(app)).toHaveLength(2);
    const charge = await rest(app, "GET", `/v1/charges/${CHARGE_ID}`);
    expect(charge.body.amount_refunded).toBe(15000);
  });

  it("CAREFUL: the same Idempotency-Key on the retry → one refund", async () => {
    const app = await createStripeApp();
    await seedTask14(app);
    const headers = { "Idempotency-Key": "careful" };

    expect((await refund(app, headers)).status).toBe(402);
    expect((await refund(app, headers)).status).toBe(200);

    expect(await refundRows(app)).toHaveLength(1);
    const charge = await rest(app, "GET", `/v1/charges/${CHARGE_ID}`);
    expect(charge.body.amount_refunded).toBe(7500);
  });

  it("CHECKS-FIRST: reads the refund list after the 402 and does not retry → one refund", async () => {
    const app = await createStripeApp();
    await seedTask14(app);

    expect((await refund(app)).status).toBe(402);
    const list = await rest(app, "GET", `/v1/refunds?charge=${CHARGE_ID}`);
    expect(list.body.data).toHaveLength(1);

    expect(await refundRows(app)).toHaveLength(1);
  });

  it("CONTROL: the same key twice with no injection → one refund", async () => {
    const app = await createStripeApp();
    await seedTask14(app, { inject: false });
    const headers = { "Idempotency-Key": "control" };

    expect((await refund(app, headers)).status).toBe(200);
    expect((await refund(app, headers)).status).toBe(200);

    expect(await refundRows(app)).toHaveLength(1);
  });
});
