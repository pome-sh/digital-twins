// SPDX-License-Identifier: Apache-2.0
//
// The x402 session surface (domain). Mounts the seller-side payment
// middleware plus the hosted protected resource on the session router.
// Only wired when the embedder knows the twin's own base URL (the
// middleware settles payments by calling the twin's REST API over HTTP) —
// the standalone server passes `http://127.0.0.1:<port>`, the CLI's
// in-process harness passes its bound URL.

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { RecorderHandle } from "@pome-sh/sdk";
import { recordedRequestHeaders } from "@pome-sh/sdk/server";
import type { ResolvedSession } from "./types.js";
import { paymentMiddleware } from "./x402.js";

export type RegisterX402RoutesOptions = {
  twinBaseUrl: string;
  recorder: RecorderHandle;
  runId: string;
};

// F-1125 — record the gated exchange, whoever answered it.
//
// The x402 legs used to reach the tape not at all. The payment middleware
// answers every challenge leg itself and returns BEFORE `next()`, so the route
// handler — the only thing a `recorder.handle()` wrapper could have covered —
// never ran; and the protected resource was registered as a bare handler
// anyway. An unpaid attempt therefore left no trace: `state_final.json` is
// identical whether the agent paid, failed to pay, or never tried, and a
// negative criterion graded over that empty tape is the free pass D4 forbids.
//
// Recording the RESPONSE rather than instrumenting the middleware's eight exit
// points keeps x402's protocol logic untouched and puts on the tape exactly
// what the client received, which is what `The retry includes X-PAYMENT and
// returns 200` asks about.
//
// The middleware's own settlement calls (`POST /v1/payment_intents`,
// `simulate_crypto_deposit`) travel over HTTP back into this twin, so they are
// recorded separately by the REST routes that serve them, with their own state
// deltas. That is why this row is `state_mutation: false`: it would otherwise
// double-count mutations the tape already carries.
function recordGatedExchange(recorder: RecorderHandle, runId: string): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    await next();
    // `c.res.clone()` — reading the live body would consume the stream the
    // client is still owed.
    let responseBody: unknown = null;
    try {
      responseBody = await c.res.clone().json();
    } catch {
      responseBody = null;
    }
    const status = c.res.status;
    recorder.record({
      ts: new Date().toISOString(),
      run_id: runId,
      twin: "stripe",
      request_id: `req_${crypto.randomUUID()}`,
      correlation_id: c.req.header("x-pome-correlation-id") ?? `req_${crypto.randomUUID()}`,
      task_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
      scenario_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
      step_id: null,
      tool_call_id: null,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      request_body: null,
      request_headers: recordedRequestHeaders(c),
      // No MCP counterpart — x402 is a wire protocol, not a twin action.
      tool: null,
      status,
      response_body: responseBody,
      latency_ms: Date.now() - started,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: status >= 400 ? x402Error(responseBody) : null,
    });
  };
}

function x402Error(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: unknown }).error;
    if (typeof message === "string") return message;
  }
  return "payment required";
}

export function registerX402Routes(session: Hono, opts: RegisterX402RoutesOptions): void {
  // Scoped to the gated prefix: a session-wide `use` would double-record every
  // REST route, which already records itself through `recorder.handle`.
  session.use("/x402/*", recordGatedExchange(opts.recorder, opts.runId));
  session.use(
    paymentMiddleware(
      {
        "GET /x402/protected-resource": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.01",
              network: "eip155:84532",
              description: "Unlock the hosted Stripe x402 protected resource",
            },
          ],
          description: "Hosted Stripe x402 protected resource",
          mimeType: "application/json",
        },
      },
      {
        twinBaseUrl: opts.twinBaseUrl,
        sid: (c: Context) => {
          const sess = c.get("session") as ResolvedSession | undefined;
          return sess?.sid ?? "default";
        },
        apiKey: (c: Context) => {
          const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
          return header.replace(/^bearer\s+/i, "");
        },
      },
    ),
  );
  session.get("/x402/protected-resource", (c) =>
    c.json({
      ok: true,
      resource: "stripe-x402-protected-resource",
      message: "Payment verified by the Stripe twin.",
    }),
  );
}
