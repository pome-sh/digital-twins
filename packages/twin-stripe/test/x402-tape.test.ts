// SPDX-License-Identifier: Apache-2.0
//
// F-1125 — what the x402 flow leaves on the recorder tape.
//
// The criterion this exists for is task 13's `The retry includes X-PAYMENT and
// returns 200`. It reads the tape, so the tape has to carry two things the
// recorder never captured: the request headers, and — first — the x402 requests
// at all. `registerX402Routes` mounted the protected resource as a BARE Hono
// handler and answered the 402 leg from inside the middleware, so neither leg
// reached the recorder: `state_final.json` is byte-identical whether the agent
// paid, failed to pay, or never tried, and the tape was empty.
//
// A negative verdict over an empty tape is the free pass D4 forbids, which is
// why both legs are asserted here rather than only the paying one.

// x402 mints and settles its PaymentIntent by calling the twin's OWN REST API
// over the network, so `app.request()` cannot serve it — the middleware's
// `fetch` reaches a real socket or nothing. This suite boots the twin through
// the `serve()` bridge on an ephemeral port (port 0: vitest workers run in
// parallel, never a fixed port), the same way `socket-boundary.test.ts` does.
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/twin.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { applySeed, defaultSeed, DEFAULT_API_KEY, DEFAULT_SID } from "../src/seed.js";

type TapeEvent = {
  method: string;
  path: string;
  status: number;
  request_headers?: Record<string, string>;
};

const auth = { Authorization: `Bearer ${DEFAULT_API_KEY}` };
let server: ReturnType<typeof serve> | undefined;
let baseUrl = "";

beforeAll(async () => {
  const db = openTwinStripeDatabase(":memory:");
  applySeed(db, defaultSeed());
  const started = await new Promise<{ server: ReturnType<typeof serve>; url: string }>(
    (resolve) => {
      // The twin needs its own URL before it can serve, and cannot know the
      // ephemeral port until it is listening — so bind first, then build the
      // app against the resolved port and let the bridge dispatch into it.
      let app: ReturnType<typeof createTwinStripeApp> | undefined;
      const handle = serve(
        { fetch: (req, ...rest) => app!.fetch(req, ...rest), port: 0, hostname: "127.0.0.1" },
        (info) => {
          const url = `http://127.0.0.1:${info.port}`;
          app = createTwinStripeApp({ db, twinBaseUrl: url, runId: "run_x402" });
          resolve({ server: handle, url });
        },
      );
    },
  );
  server = started.server;
  baseUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const resource = `/s/${DEFAULT_SID}/x402/protected-resource`;

// One server serves the whole file (x402 needs a real socket), so the tape
// ACCUMULATES across tests. Each test marks the length it starts from and reads
// only its own rows — otherwise an assertion on `[402, 200]` silently becomes an
// assertion on every leg the file has driven so far.
async function tape(since = 0): Promise<TapeEvent[]> {
  const res = await fetch(`${baseUrl}/s/${DEFAULT_SID}/_pome/events`, { headers: auth });
  const events = (await res.json()) as TapeEvent[];
  return events.filter((event) => event.path.endsWith("/x402/protected-resource")).slice(since);
}

async function tapeLength(): Promise<number> {
  return (await tape()).length;
}

describe("x402 challenge leg on the tape", () => {
  it("records the unpaid request that was answered 402", async () => {
    const since = await tapeLength();
    const res = await fetch(`${baseUrl}${resource}`, { headers: auth });
    expect(res.status).toBe(402);

    const recorded = await tape(since);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: "GET", status: 402 });
  });

  it("records the challenge leg's headers, which carry no X-PAYMENT", async () => {
    const since = await tapeLength();
    await fetch(`${baseUrl}${resource}`, { headers: auth });

    const [challenge] = await tape(since);
    expect(challenge!.request_headers).toBeDefined();
    expect(challenge!.request_headers!["x-payment"]).toBeUndefined();
  });

  it("redacts the bearer the agent authenticated the challenge with", async () => {
    const since = await tapeLength();
    await fetch(`${baseUrl}${resource}`, { headers: auth });

    const [challenge] = await tape(since);
    expect(challenge!.request_headers!.authorization).toBe("[REDACTED]");
  });
});

describe("x402 retry leg on the tape", () => {
  // The whole criterion in one test: two legs, ordered, and the second one
  // distinguishable from the first ONLY by its headers. Without them the tape
  // shows two GETs to one path and cannot say which included the payment.
  it("records the retry's X-PAYMENT header alongside its 200", async () => {
    const since = await tapeLength();
    const challenge = await fetch(`${baseUrl}${resource}`, { headers: auth });
    expect(challenge.status).toBe(402);
    const body = (await challenge.json()) as {
      accepts: { payTo: string; maxAmountRequired: string }[];
    };
    const offer = body.accepts[0]!;

    const xPayment = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: "eip155:84532",
        payload: {
          authorization: {
            from: "0xbuyer0000000000000000000000000000000000",
            to: offer.payTo,
            value: offer.maxAmountRequired,
            validAfter: 0,
            validBefore: 4102444800,
            nonce: "0xnonce1",
          },
          signature: "0xfake",
        },
      }),
      "utf8",
    ).toString("base64");

    const retry = await fetch(`${baseUrl}${resource}`, {
      headers: { ...auth, "X-PAYMENT": xPayment },
    });
    expect(retry.status).toBe(200);

    const recorded = await tape(since);
    expect(recorded.map((event) => event.status)).toEqual([402, 200]);
    expect(recorded[0]!.request_headers!["x-payment"]).toBeUndefined();
    expect(recorded[1]!.request_headers!["x-payment"]).toBe(xPayment);
  });
});
