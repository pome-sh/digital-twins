// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  createLinearTwinApp,
  openLinearTwinDatabase,
  type LinearStateSeed,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const SCOPES = ["read", "write", "issues:create", "comments:create", "admin"];

const secret = "linear-oauth-test-secret-32-chars!!";
const sid = DEFAULT_LINEAR_SID;
const previousSecret = process.env.TWIN_AUTH_SECRET;
let jwt: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  jwt = await sign(
    {
      sid,
      team_id: "tm_linear",
      linear_email: DEFAULT_LINEAR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret
  );
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function appSeed(): LinearStateSeed {
  const base = testSeed();
  return {
    ...base,
    oauthApps: [
      ...(base.oauthApps ?? []),
      {
        id: "oauth_app_actor",
        clientId: "lin_app_actor_client",
        clientSecret: "app_actor_client_secret",
        name: "App Actor Linear",
        redirectUris: ["http://localhost:3000/callback"],
        scopes: [...SCOPES],
        actor: "app",
        assignable: true,
        mentionable: true,
        appUserId: "user_agent",
      },
    ],
  };
}

function fixture(seed: LinearStateSeed = appSeed()) {
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({ db, seed, runId: "oauth-test" });
  return { app, db };
}

describe("Linear OAuth", () => {
  it("serves authorize HTML", async () => {
    const { app } = fixture();
    const response = await app.request(
      "/oauth/authorize?client_id=lin_example_client_id&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fcallback%2Flinear&response_type=code&scope=read"
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<!doctype html>");
    expect(html.toLowerCase()).toContain("authorize");
  });

  it("issues client_credentials tokens for app-actor OAuth apps", async () => {
    const { app } = fixture();
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "lin_app_actor_client",
        client_secret: "app_actor_client_secret",
        scope: "read write",
      }).toString(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      token_type: string;
      scope?: string;
    };
    expect(body.access_token).toBeTruthy();
    expect(body.token_type.toLowerCase()).toBe("bearer");
  });

  it("keeps OAuth client secrets out of /_pome/state", async () => {
    const { app } = fixture();
    const response = await app.request(`/s/${sid}/_pome/state`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("example_client_secret");
    expect(text).not.toContain("app_actor_client_secret");
    expect(text).toContain("[redacted]");
  });

  it("rejects authorize when no OAuth apps are seeded", async () => {
    const { app } = fixture({ ...testSeed(), oauthApps: [] });
    const response = await app.request(
      "/oauth/authorize?client_id=missing&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&response_type=code"
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/not registered|No OAuth applications/i);
  });

  it("rejects authorize with an unregistered redirect_uri", async () => {
    const { app } = fixture();
    const response = await app.request(
      "/oauth/authorize?client_id=lin_example_client_id&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&response_type=code&scope=read"
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/Redirect URI mismatch/i);
  });

  it("exchanges authorization_code with PKCE S256 and rotates refresh tokens", async () => {
    const { app } = fixture();
    const { verifier, challenge } = pkcePair();
    const redirectUri = "http://localhost:3000/api/auth/callback/linear";

    const authorize = await app.request(
      `/oauth/authorize?client_id=lin_example_client_id&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=read write&code_challenge=${challenge}&code_challenge_method=S256`
    );
    expect(authorize.status).toBe(200);

    const callback = await app.request("/oauth/authorize/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "lin_example_client_id",
        redirect_uri: redirectUri,
        scope: "read write",
        user_ref: "user_admin",
        actor: "user",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString(),
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    const location = callback.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        client_id: "lin_example_client_id",
        client_secret: "example_client_secret",
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const first = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(first.access_token).toMatch(/^lin_/);
    expect(first.refresh_token).toMatch(/^lin_refresh_/);

    const refreshResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token!,
        client_id: "lin_example_client_id",
        client_secret: "example_client_secret",
      }).toString(),
    });
    expect(refreshResponse.status).toBe(200);
    const second = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const reuse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token!,
        client_id: "lin_example_client_id",
        client_secret: "example_client_secret",
      }).toString(),
    });
    expect(reuse.status).toBe(400);
  });
});
