// SPDX-License-Identifier: Apache-2.0
//
// `create_refund.reason` takes Stripe's closed set, at both doors (F-1484).
//
// ── THE FALSE PASS THIS CLOSES ─────────────────────────────────────────────
//
// The twin declared `reason` as a free string on both surfaces — `z.string()`
// on the MCP tool and `z.string().nullish()` on `POST /v1/refunds` — while
// Stripe declares exactly `["duplicate","fraudulent","requested_by_customer"]`
// on both. So `reason: "customer_was_rude"` created a refund here and would
// have been 400'd by Stripe, and an examinee that made that call was graded as
// having succeeded. F-1469 registered it as the ONE `[COVERAGE GAP]` in
// `stripe.mcp.yaml` (`STRIPE-MCP-014`) rather than fixing it inline, because
// narrowing an accepted value is a tightening and F-1330's discipline puts a
// tightening behind a corpus heat reading. That read came back zero.
//
// ── WHY THE ASSERTIONS GO THROUGH THE TWIN AND COUNT ROWS ──────────────────
//
// A schema-shaped test — "does `safeParse` reject it?" — passes on a twin whose
// route never runs that schema. The MCP door and the REST door reach
// `domain.createRefund` by two independent paths (`executeTool` parses with the
// tool's zod; `declaredRoute` parses with `CREATE_REFUND_BODY`), so tightening
// one proves nothing about the other. Every refusal below is therefore checked
// against the refund LIST as well as the status code: a 400 that still wrote a
// row is the failure mode a status-only assertion cannot see.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";
import { toolArgumentSchemas } from "../src/tools.js";

/** Stripe's three, read off the committed capture below — never restated by hand. */
const STRIPE_REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;

/** A value with the right TYPE and the wrong VALUE. The whole point is that a
 * `z.string()` cannot tell these apart. */
const NOT_A_STRIPE_REASON = "customer_was_rude";

async function settledCharge(app: StripeTestApp, amount: number): Promise<string> {
  const pi = await rest(app, "POST", "/v1/payment_intents", {
    amount,
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_options: {
      crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
    },
  });
  const settled = await rest(
    app,
    "POST",
    `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
  );
  return settled.body.latest_charge as string;
}

async function refundCount(app: StripeTestApp): Promise<number> {
  const list = await rest(app, "GET", "/v1/refunds");
  expect(list.status).toBe(200);
  return (list.body.data as unknown[]).length;
}

describe("create_refund.reason — Stripe's closed set, over the MCP door", () => {
  it.each(STRIPE_REASONS)("accepts %s and stores it on the refund", async (reason) => {
    const app = await createStripeApp();
    const charge = await settledCharge(app, 20000);

    const call = await callTool(app, "create_refund", { charge, amount: 1000, reason });

    expect(call.status).toBe(200);
    expect(call.body).toMatchObject({ object: "refund", amount: 1000, charge, reason });
  });

  it(`refuses ${NOT_A_STRIPE_REASON} — and writes nothing`, async () => {
    const app = await createStripeApp();
    const charge = await settledCharge(app, 20000);
    const before = await refundCount(app);

    const call = await callTool(app, "create_refund", {
      charge,
      amount: 1000,
      reason: NOT_A_STRIPE_REASON,
    });

    expect(call.status).toBe(400);
    expect(call.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "parameter_invalid",
      param: "reason",
    });
    // The teeth. A validator that refuses AFTER the domain has written is a
    // twin that reports failure and mutates anyway — worse than the false pass
    // this replaces, and invisible to the status code.
    expect(await refundCount(app)).toBe(before);
  });

  it("still accepts an absent reason — the tightening narrows the value, not the arity", async () => {
    // Stripe does not require `reason`; `PostRefunds` omits it from `required`.
    // A `z.enum()` that lost its `.optional()` would refuse every refund the
    // corpus actually makes, and every one of those calls is correct.
    const app = await createStripeApp();
    const charge = await settledCharge(app, 20000);

    const call = await callTool(app, "create_refund", { charge, amount: 1000 });

    expect(call.status).toBe(200);
    expect(call.body).toMatchObject({ object: "refund", reason: null });
  });
});

describe("create_refund.reason — the same set over the REST door", () => {
  // `POST /v1/refunds` is a separate validator reaching the same domain
  // function. Stripe closes the enum on this door too — `PostRefunds` declares
  // the identical three values — so a twin tightened only at the MCP boundary
  // still false-passes every examinee that speaks REST.
  it.each(STRIPE_REASONS)("accepts %s", async (reason) => {
    const app = await createStripeApp();
    const charge = await settledCharge(app, 20000);

    const created = await rest(app, "POST", "/v1/refunds", { charge, amount: 1000, reason });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: "refund", amount: 1000, charge, reason });
  });

  it(`refuses ${NOT_A_STRIPE_REASON} — and writes nothing`, async () => {
    const app = await createStripeApp();
    const charge = await settledCharge(app, 20000);
    const before = await refundCount(app);

    const created = await rest(app, "POST", "/v1/refunds", {
      charge,
      amount: 1000,
      reason: NOT_A_STRIPE_REASON,
    });

    expect(created.status).toBe(400);
    expect(created.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "parameter_invalid",
    });
    expect(await refundCount(app)).toBe(before);
  });

  it("still accepts an absent reason", async () => {
    const app = await createStripeApp();
    const charge = await settledCharge(app, 20000);

    const created = await rest(app, "POST", "/v1/refunds", { charge, amount: 1000 });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: "refund", reason: null });
  });
});

// ── THE SET IS THE VENDOR'S, AND THIS READS IT RATHER THAN REPEATING IT ────
//
// `STRIPE_REASONS` above is a literal so the `it.each` names are legible; this
// is the check that it still describes Stripe. The evidence is the committed
// `tools/list` capture read live off https://mcp.stripe.com on 2026-08-10 — the
// same golden the fidelity MCP lane diffs this twin against — so if Stripe ever
// widens or narrows the set, this fails and the twin follows the capture.
describe("the enum is Stripe's, read off the committed capture", () => {
  it("matches the upstream golden's create_refund.reason.enum", () => {
    const golden = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "stripe.raw.json"),
        "utf8"
      )
    ) as {
      result: {
        tools: Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[] }> } }>;
      };
    };
    const upstream = golden.result.tools.find((t) => t.name === "create_refund");
    expect(upstream?.inputSchema.properties?.reason?.enum).toEqual([...STRIPE_REASONS]);
  });

  it("binds both of the twin's validators to that set", () => {
    // Asserted through the schemas as well as through the routes above, because
    // the routes can only show that SOME values are refused. Only the schema
    // shows the boundary is exactly the vendor's — no fourth member, no gap.
    const mcp = toolArgumentSchemas.find((t) => t.name === "create_refund")!.schema;
    for (const reason of STRIPE_REASONS) {
      expect(mcp.safeParse({ charge: "ch_1", reason }).success, reason).toBe(true);
    }
    expect(mcp.safeParse({ charge: "ch_1", reason: NOT_A_STRIPE_REASON }).success).toBe(false);
    // ⚠️ NOT a `.min(1)` string with a comment. An empty string and a plausible
    // near-miss are both refused, which is the difference between narrowing a
    // value and merely requiring one.
    expect(mcp.safeParse({ charge: "ch_1", reason: "" }).success).toBe(false);
    expect(mcp.safeParse({ charge: "ch_1", reason: "Duplicate" }).success).toBe(false);
  });
});
