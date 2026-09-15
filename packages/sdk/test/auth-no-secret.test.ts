// SPDX-License-Identifier: Apache-2.0
// With no TWIN_AUTH_SECRET and no opt-in, no token can verify (F-1801). That is
// the caller's 401 on both bearer shapes, never a 500 that blames the caller
// for the process's configuration.
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearerAuth, mintProviderToken, MissingAuthSecretError, resolveAuthSecret } from "../src/auth.js";

const SPEC = { provider: "stripe", prefixes: ["sk_test_pome_"] } as const;

function app() {
  const a = new Hono();
  a.use("/s/:sid/*", bearerAuth({ providerToken: SPEC }));
  a.get("/s/:sid/ping", (c) => c.json({ ok: true }));
  return a;
}

const prevSecret = process.env.TWIN_AUTH_SECRET;
const prevOptIn = process.env.POME_ALLOW_DEV_SECRETS;

beforeEach(() => {
  delete process.env.TWIN_AUTH_SECRET;
  delete process.env.POME_ALLOW_DEV_SECRETS;
});

afterEach(() => {
  if (prevSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = prevSecret;
  if (prevOptIn === undefined) delete process.env.POME_ALLOW_DEV_SECRETS;
  else process.env.POME_ALLOW_DEV_SECRETS = prevOptIn;
});

describe("bearerAuth with no secret in the process", () => {
  it("resolveAuthSecret names the failure", () => {
    expect(() => resolveAuthSecret()).toThrow(MissingAuthSecretError);
  });

  it("answers a provider-shaped token with 401, not 500", async () => {
    const res = await app().request("/s/alice/ping", {
      headers: { Authorization: "Bearer sk_test_pome_whatever" },
    });
    expect(res.status).toBe(401);
  });

  it("answers a session JWT with 401, not 500", async () => {
    const token = await sign({ sid: "alice", team_id: "tm_x", exp: Math.floor(Date.now() / 1000) + 60 }, "some-other-secret-32-chars-long!!");
    const res = await app().request("/s/alice/ping", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("verifies again the moment a secret is set, on both shapes", async () => {
    process.env.TWIN_AUTH_SECRET = "test-secret-32-chars-minimum-length";
    const provider = mintProviderToken(SPEC, { sid: "alice" });
    expect((await app().request("/s/alice/ping", { headers: { Authorization: `Bearer ${provider}` } })).status).toBe(200);
    const jwt = await sign({ sid: "alice", team_id: "tm_x", exp: Math.floor(Date.now() / 1000) + 60 }, process.env.TWIN_AUTH_SECRET);
    expect((await app().request("/s/alice/ping", { headers: { Authorization: `Bearer ${jwt}` } })).status).toBe(200);
  });
});
