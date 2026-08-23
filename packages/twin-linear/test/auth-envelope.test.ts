// SPDX-License-Identifier: Apache-2.0
// Twin-linear's auth-refusal envelopes, measured against Linear.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLinearTwinApp, openLinearTwinDatabase } from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SECRET = "linear-auth-envelope-test-secret!";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const previousAdminToken = process.env.TWIN_ADMIN_TOKEN;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
  if (previousAdminToken === undefined) delete process.env.TWIN_ADMIN_TOKEN;
  else process.env.TWIN_ADMIN_TOKEN = previousAdminToken;
});

function app() {
  process.env.TWIN_AUTH_SECRET = SECRET;
  return createLinearTwinApp({ db: openLinearTwinDatabase(":memory:"), seed: testSeed() });
}

/** Linear's measured 401, in full. The single expectation every leg shares. */
const VENDOR_401 = {
  errors: [
    {
      message: "Authentication required, not authenticated",
      extensions: {
        type: "authentication error",
        code: "AUTHENTICATION_ERROR",
        statusCode: 401,
        userError: true,
        userPresentableMessage: "You need to authenticate to access this operation.",
        meta: {},
        http: { status: 401 },
      },
    },
  ],
};

async function refuse(init: RequestInit = {}) {
  const response = await app().request("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify({ query: "query { viewer { id } }" }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("linear answers ONE 401 body, because Linear does", () => {
  it("a BAD bearer answers Linear's body, whole", async () => {
    const got = await refuse({ headers: { authorization: "Bearer f1497-invalid-not-a-real-token" } });

    expect(got.status).toBe(401);
    expect(typeof got.status).toBe("number");
    // The WHOLE body, so a change that restores `message` while dropping
    // `statusCode` or `meta` cannot pass on the leaf it touched.
    expect(got.body).toEqual(VENDOR_401);
  });

  it("NO Authorization header answers the SAME body — measured identical", async () => {
    // The interesting negative result of the five probes: github, gmail and stripe all
    // split bad-vs-missing, and Linear does not.
    const got = await refuse();
    expect(got.status).toBe(401);
    expect(got.body).toEqual(VENDOR_401);
  });

  it("a sid mismatch answers it too — Linear has no session-id concept", async () => {
    // Was `Session id mismatch`. A caller cannot distinguish this from any
    // other authentication failure against real Linear, so the twin must not
    // let it.
    const other = await import("hono/jwt").then(({ sign }) =>
      sign({ sid: "somebody-else", team_id: "tm_x", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
    );
    const response = await app().request(`/s/this-session/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${other}` },
      body: JSON.stringify({ query: "query { viewer { id } }" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(VENDOR_401);
  });

  it("says neither `Bad credentials` nor `Session id mismatch` anywhere", async () => {
    // The leak this fix closed, asserted as an absence so it cannot creep back
    // in through a helper's default argument.
    for (const init of [{ headers: { authorization: "Bearer nope" } }, {}]) {
      const serialised = JSON.stringify((await refuse(init)).body);
      expect(serialised).not.toContain("Bad credentials");
      expect(serialised).not.toContain("Session id mismatch");
    }
  });
});

describe("linear's admin-gate 403 is GraphQL-shaped, not GitHub's", () => {
  it("answers an errors[] envelope with no documentation_url", async () => {
    // ⚠️ THIS BODY USED TO COME FROM `@pome-sh/sdk`'s shared admin gate:
    // `{message:"Forbidden", documentation_url:""}` — GitHub's envelope, with
    // GitHub's key, on a GraphQL twin that has no top-level `message` anywhere
    // else in its surface.
    process.env.TWIN_ADMIN_TOKEN = "f1497-linear-admin-token";
    const response = await app().request("/admin/reset", { method: "POST" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      errors: [
        { message: "Forbidden", extensions: { code: "FORBIDDEN", http: { status: 403 } } },
      ],
    });
  });
});

describe("the leaves Linear does NOT send, pinned as absences", () => {
  it("no `documentation_url` on any refusal, 401 or 403", async () => {
    process.env.TWIN_ADMIN_TOKEN = "f1497-linear-admin-token";
    const bodies = [
      JSON.stringify((await refuse({ headers: { authorization: "Bearer nope" } })).body),
      JSON.stringify((await refuse()).body),
      await (await app().request("/admin/reset", { method: "POST" })).text(),
    ];
    for (const body of bodies) expect(body).not.toContain("documentation_url");
  });

  it("the status leaves are NUMBERS, where github's are strings", async () => {
    // The trap on the other side: twin-github's `status` leaf is a quoted `"401"`,
    // measured 59/59.
    const extensions = ((await refuse()).body.errors as Array<{ extensions: Record<string, unknown> }>)[0]
      .extensions;
    expect(extensions.statusCode).toBe(401);
    expect(typeof extensions.statusCode).toBe("number");
    expect((extensions.http as { status: unknown }).status).toBe(401);
    expect(typeof (extensions.http as { status: unknown }).status).toBe("number");
  });
});
