// SPDX-License-Identifier: Apache-2.0
// Twin-gmail's auth-refusal envelopes, measured against Google.
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGmailTwinApp } from "../src/index.js";

const SID = "gmail-auth-envelope";
const SECRET = "gmail-auth-envelope-test-secret";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const previousAdminToken = process.env.TWIN_ADMIN_TOKEN;

const OAUTH_TAIL =
  "Expected OAuth 2 access token, login cookie or other valid authentication credential. " +
  "See https://developers.google.com/identity/sign-in/web/devconsole-project.";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
  if (previousAdminToken === undefined) delete process.env.TWIN_ADMIN_TOKEN;
  else process.env.TWIN_ADMIN_TOKEN = previousAdminToken;
});

const path = `/s/${SID}/gmail/v1/users/me/profile`;

async function refuse(init: RequestInit = {}) {
  const response = await createGmailTwinApp().request(path, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("gmail's 401 tells a bad credential from a missing one", () => {
  it("a BAD bearer answers Google's invalid-credentials body, whole", async () => {
    const got = await refuse({ headers: { authorization: "Bearer f1497-invalid-not-a-real-token" } });

    expect(got.status).toBe(401);
    expect(typeof got.status).toBe("number");
    // The WHOLE body. A change that fixed `message` while dropping `errors[]`
    // or the nested `status` would pass a per-leaf assertion and fail here.
    expect(got.body).toEqual({
      error: {
        code: 401,
        message: `Request had invalid authentication credentials. ${OAUTH_TAIL}`,
        errors: [
          {
            message: "Invalid Credentials",
            domain: "global",
            reason: "authError",
            location: "Authorization",
            locationType: "header",
          },
        ],
        status: "UNAUTHENTICATED",
      },
    });
  });

  it("NO Authorization header answers the missing-credential body instead", async () => {
    // The fix. This used to be byte-identical to the test above, which
    // is what made it a measured divergence rather than a shape question.
    const got = await refuse();

    expect(got.status).toBe(401);
    expect(got.body).toEqual({
      error: {
        code: 401,
        message: `Request is missing required authentication credential. ${OAUTH_TAIL}`,
        errors: [
          {
            message: "Login Required.",
            domain: "global",
            reason: "required",
            location: "Authorization",
            locationType: "header",
          },
        ],
        status: "UNAUTHENTICATED",
      },
    });
  });

  it("the two bodies actually differ — three leaves, not one", async () => {
    // Teeth against the way this fix could silently un-fix itself: a `kind`
    // parameter that stops being threaded through renders one body twice, and
    // both assertions above would still have to be edited to notice. This one
    // notices on its own.
    const bad = (await refuse({ headers: { authorization: "Bearer f1497-invalid" } })).body;
    const missing = (await refuse()).body;
    expect(missing).not.toEqual(bad);

    const leaf = (body: Record<string, unknown>, key: string) =>
      (body.error as Record<string, unknown> | undefined)?.[key];
    expect(leaf(bad, "message")).not.toBe(leaf(missing, "message"));
    expect((leaf(bad, "errors") as Array<{ message: string; reason: string }>)[0]).not.toEqual(
      (leaf(missing, "errors") as Array<{ message: string; reason: string }>)[0]
    );
  });

  it("a sid mismatch takes the INVALID body — the credential is not this session's", async () => {
    const token = await sign(
      { sid: "somebody-else", team_id: "tm_x", exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET
    );
    const got = await refuse({ headers: { authorization: `Bearer ${token}` } });

    expect(got.status).toBe(401);
    expect((got.body.error as { message: string }).message).toBe(
      `Request had invalid authentication credentials. ${OAUTH_TAIL}`
    );
  });
});

describe("gmail's admin-gate 403 is Google-shaped, not GitHub's", () => {
  it("answers PERMISSION_DENIED with no documentation_url", async () => {
    // ⚠️ THIS BODY USED TO COME FROM `@pome-sh/sdk`'s shared admin gate, and it
    // read `{message:"Forbidden", documentation_url:""}` — GitHub's envelope,
    // with GitHub's key, on a Google twin. The gate is shared by all five
    // twins, so it could not be fixed there; twin-gmail declares its own now.
    process.env.TWIN_ADMIN_TOKEN = "f1497-gmail-admin-token";
    const response = await createGmailTwinApp().request("/admin/reset", { method: "POST" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 403,
        message: "Forbidden",
        errors: [{ message: "Forbidden", domain: "global", reason: "forbidden" }],
        status: "PERMISSION_DENIED",
      },
    });
  });
});

describe("the leaves Google does NOT send, pinned as absences", () => {
  it("no `documentation_url` anywhere, on any refusal", async () => {
    // The one-line reading of the measurement: of five vendors, only GitHub sends this
    // key.
    process.env.TWIN_ADMIN_TOKEN = "f1497-gmail-admin-token";
    const app = createGmailTwinApp();
    const bodies = [
      JSON.stringify((await refuse({ headers: { authorization: "Bearer nope" } })).body),
      JSON.stringify((await refuse()).body),
      await (await app.request("/admin/reset", { method: "POST" })).text(),
    ];
    for (const body of bodies) expect(body).not.toContain("documentation_url");
  });

  it("no TOP-LEVEL `status` leaf — the only `status` is the nested gRPC one", async () => {
    // Google's `status` is `error.status` and it is a gRPC canonical name
    // (`UNAUTHENTICATED`), not GitHub's stringified HTTP code at the root. A
    // fix that pattern-matched twin-github would have put `status: "401"` here.
    const got = await refuse();
    expect("status" in got.body).toBe(false);
    expect((got.body.error as { status: string }).status).toBe("UNAUTHENTICATED");
  });

  it("the missing-credential body carries NO `details[]` — a registered gap", async () => {
    // ⚠️ A GAP, NOT A FIDELITY CLAIM. Google sends a `details[]` block here
    // naming the backend method (`caribou.api.proto.MailboxService.GetProfile`).
    // Reproducing it means naming the operation on a 401, which is precisely
    // what authentication-before-dispatch makes impossible to know. Registered
    // in FIDELITY.md instead; when somebody finds a defensible way to fill it,
    // this test fails and that is the signal.
    const got = await refuse();
    expect("details" in (got.body.error as object)).toBe(false);
  });
});
