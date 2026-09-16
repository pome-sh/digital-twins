// SPDX-License-Identifier: Apache-2.0
// Admin-gate coverage for twin-slack: the gate MECHANISM (token mode, loopback socket
// check, fail-closed on a missing peer) is the engine's and is covered there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "admin" });
}

describe("admin gate — token mode renders the slack envelope", () => {
  beforeEach(() => {
    process.env.TWIN_ADMIN_TOKEN = "super-secret-admin-token";
  });
  afterEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("rejects missing X-Admin-Token with restricted_action", async () => {
    const app = freshApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("restricted_action");
  });

  it("rejects wrong X-Admin-Token", async () => {
    const app = freshApp();
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "wrong" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("restricted_action");
  });

  it("accepts the correct X-Admin-Token (case-insensitive header)", async () => {
    const app = freshApp();
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "x-admin-token": "super-secret-admin-token" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("admin gate — fallback (no TWIN_ADMIN_TOKEN)", () => {
  // The vitest config opts every in-process suite into the gate; this block
  // covers the gate itself, so it takes the opt-in away first. vitest 5's
  // `test.env` is a getter — `delete process.env.X` does not stick across a
  // later NODE_ENV mutation, so stubEnv is the override that wins.
  beforeEach(() => {
    vi.stubEnv("TWIN_ADMIN_TOKEN", "");
    vi.stubEnv("TWIN_ADMIN_ALLOW_NO_PEER", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("admits in-process requests only under TWIN_ADMIN_ALLOW_NO_PEER=1", async () => {
    vi.stubEnv("TWIN_ADMIN_ALLOW_NO_PEER", "1");
    const app = freshApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("rejects unknown-peer requests in production with restricted_action", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = freshApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("restricted_action");
  });
});
