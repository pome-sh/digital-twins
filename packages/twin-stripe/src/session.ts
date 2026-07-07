// SPDX-License-Identifier: Apache-2.0
//
// The x402 session surface (domain). Mounts the seller-side payment
// middleware plus the hosted protected resource on the session router.
// Only wired when the embedder knows the twin's own base URL (the
// middleware settles payments by calling the twin's REST API over HTTP) —
// the standalone server passes `http://127.0.0.1:<port>`, the CLI's
// in-process harness passes its bound URL.

import type { Hono } from "hono";
import type { ResolvedSession } from "./types.js";
import { paymentMiddleware } from "./x402.js";

export type RegisterX402RoutesOptions = {
  twinBaseUrl: string;
};

export function registerX402Routes(session: Hono, opts: RegisterX402RoutesOptions): void {
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
        sid: (c) => {
          const sess = c.get("session") as ResolvedSession | undefined;
          return sess?.sid ?? "default";
        },
        apiKey: (c) => {
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
