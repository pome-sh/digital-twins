// SPDX-License-Identifier: Apache-2.0
// The admin gate's fallback tier fails CLOSED on a missing peer (F-1804). Until
// this it read NODE_ENV and admitted every in-process caller outside
// "production" — NODE_ENV unset, "staging", "preview" and "test" all fell open.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_NO_PEER_OPT_IN, createAdminGate, setClientIp } from "../src/admin-gate.js";

function gatedApp(peer?: string) {
  const app = new Hono();
  if (peer !== undefined) {
    app.use("*", async (c, next) => {
      setClientIp(c, peer);
      await next();
    });
  }
  app.use("/admin/*", createAdminGate());
  app.post("/admin/reset", (c) => c.json({ ok: true }));
  return app;
}

const prevToken = process.env.TWIN_ADMIN_TOKEN;
const prevOptIn = process.env[ADMIN_NO_PEER_OPT_IN];
const prevNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.TWIN_ADMIN_TOKEN;
  delete process.env[ADMIN_NO_PEER_OPT_IN];
});

afterEach(() => {
  if (prevToken === undefined) delete process.env.TWIN_ADMIN_TOKEN;
  else process.env.TWIN_ADMIN_TOKEN = prevToken;
  if (prevOptIn === undefined) delete process.env[ADMIN_NO_PEER_OPT_IN];
  else process.env[ADMIN_NO_PEER_OPT_IN] = prevOptIn;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

describe("createAdminGate — no TWIN_ADMIN_TOKEN, no transport peer", () => {
  it("refuses whatever NODE_ENV says", async () => {
    for (const nodeEnv of [undefined, "production", "staging", "development", "test"]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      const res = await gatedApp().request("/admin/reset", { method: "POST" });
      expect(res.status, `NODE_ENV=${String(nodeEnv)}`).toBe(403);
    }
  });

  it("admits only under the exact TWIN_ADMIN_ALLOW_NO_PEER=1 opt-in", async () => {
    process.env[ADMIN_NO_PEER_OPT_IN] = "1";
    expect((await gatedApp().request("/admin/reset", { method: "POST" })).status).toBe(200);
    process.env[ADMIN_NO_PEER_OPT_IN] = "true";
    expect((await gatedApp().request("/admin/reset", { method: "POST" })).status).toBe(403);
  });
});

describe("createAdminGate — no TWIN_ADMIN_TOKEN, peer known", () => {
  it("admits a loopback peer and refuses any other, opt-in or not", async () => {
    process.env[ADMIN_NO_PEER_OPT_IN] = "1";
    expect((await gatedApp("127.0.0.1").request("/admin/reset", { method: "POST" })).status).toBe(200);
    expect((await gatedApp("::1").request("/admin/reset", { method: "POST" })).status).toBe(200);
    expect((await gatedApp("10.0.0.7").request("/admin/reset", { method: "POST" })).status).toBe(403);
  });
});

describe("createAdminGate — TWIN_ADMIN_TOKEN set", () => {
  it("ignores the peer and the opt-in: only the header decides", async () => {
    process.env.TWIN_ADMIN_TOKEN = "gate-test-token";
    process.env[ADMIN_NO_PEER_OPT_IN] = "1";
    expect((await gatedApp().request("/admin/reset", { method: "POST" })).status).toBe(403);
    expect((await gatedApp("127.0.0.1").request("/admin/reset", { method: "POST" })).status).toBe(403);
    const right = await gatedApp("10.0.0.7").request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "gate-test-token" },
    });
    expect(right.status).toBe(200);
  });
});
