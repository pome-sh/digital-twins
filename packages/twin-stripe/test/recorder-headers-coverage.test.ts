// SPDX-License-Identifier: Apache-2.0
// Every emission site captures headers, not just the engine's.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, callTool, type StripeTestApp } from "./_appHelper.js";
import { withAuth } from "./_authHelper.js";

type TapeEvent = {
  method: string;
  path: string;
  status: number;
  request_headers?: Record<string, string>;
  tool?: string | null;
  idempotency_dedupe?: boolean;
};

async function tape(test: StripeTestApp): Promise<TapeEvent[]> {
  const res = await test.app.request(`${test.base}/_pome/events`, withAuth(test.token));
  return (await res.json()) as TapeEvent[];
}

describe("request_headers coverage across stripe's emission sites", () => {
  it("captures headers on a REST mutation recorded by respond()", async () => {
    const test = await createStripeApp();
    const created = await rest(test, "POST", "/v1/payment_intents", {
      amount: 1200,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    expect(created.status).toBe(200);

    const rows = await tape(test);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.request_headers, `${row.method} ${row.path} has no request_headers`).toBeDefined();
    }
  });

  it("captures headers on the idempotency dedupe replay", async () => {
    const test = await createStripeApp();
    const init = {
      amount: 1200,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    };
    await rest(test, "POST", "/v1/payment_intents", init, { "Idempotency-Key": "idem_cover" });
    await rest(test, "POST", "/v1/payment_intents", init, { "Idempotency-Key": "idem_cover" });

    const rows = await tape(test);
    const replay = rows.find((row) => row.idempotency_dedupe === true);
    expect(replay, "no dedupe replay row on the tape").toBeDefined();
    expect(replay!.request_headers).toBeDefined();
    // The key that CAUSED the dedupe has to be readable, or the row records the
    // outcome while hiding the reason.
    expect(replay!.request_headers!["idempotency-key"]).toBe("idem_cover");
  });

  it("captures headers on an unsupported-endpoint 501", async () => {
    const test = await createStripeApp();
    await rest(test, "GET", "/v1/subscriptions");

    const rows = await tape(test);
    for (const row of rows) {
      expect(row.request_headers, `${row.method} ${row.path} has no request_headers`).toBeDefined();
    }
  });

  it("captures headers on an MCP tool dispatch and stamps the tool name", async () => {
    const test = await createStripeApp();
    const result = await callTool(test, "create_payment_intent", {
      amount: 1200,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    expect(result.status).toBe(200);

    const rows = await tape(test);
    const dispatch = rows.find((row) => row.path.endsWith("/mcp/call"));
    expect(dispatch, "no /mcp/call row on the tape").toBeDefined();
    expect(dispatch!.request_headers).toBeDefined();
    expect(dispatch!.tool).toBe("create_payment_intent");
  });
});
