// SPDX-License-Identifier: Apache-2.0
// Twin-stripe's auth-refusal envelopes, measured against Stripe.
import { afterAll, describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
const previousAdminToken = process.env.TWIN_ADMIN_TOKEN;

afterAll(() => {
  if (previousAdminToken === undefined) delete process.env.TWIN_ADMIN_TOKEN;
  else process.env.TWIN_ADMIN_TOKEN = previousAdminToken;
});

const NO_API_KEY_MESSAGE =
  "You did not provide an API key. You need to provide your API key in the " +
  "Authorization header, using Bearer auth (e.g. 'Authorization: Bearer " +
  "YOUR_SECRET_KEY'). See https://stripe.com/docs/api#authentication for " +
  "details, or we can help at https://support.stripe.com/.";

async function refuse(init: RequestInit = {}) {
  const response = await createTwinStripeApp().request("/v1/customers", init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("stripe tells a missing API key from a bad one", () => {
  it("NO Authorization header answers Stripe's did-not-provide message, whole body", async () => {
    // The fix. The `no_token` classification used to fall through to the JWT branch's
    // `Bad credentials`, which is GitHub's string on a Stripe twin, and it was.
    const got = await refuse();

    expect(got.status).toBe(401);
    expect(typeof got.status).toBe("number");
    expect(got.body).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unauthorized",
        message: NO_API_KEY_MESSAGE,
      },
    });
  });

  it("an api-key-shaped bearer that resolves nowhere still says Invalid API Key provided.", async () => {
    // The frozen pre-port branch, unchanged and asserted whole so the
    // new `no_token` leg cannot have swallowed it.
    const got = await refuse(withAuth("sk_test_pome_definitely_not_minted"));

    expect(got.status).toBe(401);
    expect(got.body).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unauthorized",
        message: "Invalid API Key provided.",
      },
    });
  });

  it("a JWT-shaped bearer that verifies nowhere still says Bad credentials", async () => {
    // Also frozen, and NOT a leak: this branch is the twin's own JWT auth, which real
    // Stripe has no counterpart for.
    const got = await refuse(withAuth("aaa.bbb.ccc"));

    expect(got.status).toBe(401);
    expect((got.body.error as { message: string }).message).toBe("Bad credentials");
  });

  it("the keyless body is neither of the other two, including GitHub's string", async () => {
    // ⚠️ "The three bodies differ" is NOT enough teeth, and the neuter proved
    // it: reverting the `no_token` leg sends the keyless request to
    // `Bad credentials` while an api-key-shaped one still says
    // `Invalid API Key provided.`, so a differ-from-each-other assertion stays
    // green through the exact regression it is meant to catch. What actually
    // discriminates is naming the two strings the keyless body must NOT be —
    // `Bad credentials` above all, because that is the leak: GitHub's message,
    // reachable from every `/v1/*` path with a bare curl and no credential.
    const keyless = ((await refuse()).body.error as { message: string }).message;
    expect(keyless).not.toBe("Bad credentials");
    expect(keyless).not.toBe("Invalid API Key provided.");
    expect(keyless).toBe(NO_API_KEY_MESSAGE);
  });

  it("a sid mismatch is still the frozen 403, not a 401", async () => {
    // stripe is the only twin answering a sid mismatch with 403 (CONTRACT.md), and the
    // auth fix did not touch it.
    const token = await signTestToken({ sid: "somebody-else" });
    const response = await createTwinStripeApp().request(`/s/${TEST_SID}/v1/customers`, withAuth(token));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "forbidden",
        message: "Session id mismatch.",
      },
    });
  });
});

describe("the leaves Stripe does NOT send, pinned as absences", () => {
  it("no `documentation_url` and no top-level `status` on any refusal", async () => {
    process.env.TWIN_ADMIN_TOKEN = "f1497-stripe-admin-token";
    const forbidden = await createTwinStripeApp().request("/admin/reset", { method: "POST" });
    expect(forbidden.status).toBe(403);

    const bodies = [
      (await refuse()).body,
      (await refuse(withAuth("sk_test_pome_nope"))).body,
      (await forbidden.json()) as Record<string, unknown>,
    ];
    for (const body of bodies) {
      // Serialised, so a leak into the nested `error` object is caught too —
      // `stripeError` has a `doc_url` slot and this is what keeps auth out of it.
      expect(JSON.stringify(body)).not.toContain("documentation_url");
      expect("status" in body).toBe(false);
    }
    delete process.env.TWIN_ADMIN_TOKEN;
  });
});
