// SPDX-License-Identifier: Apache-2.0
// Admin-gate coverage for twin-github: the gate MECHANISM (token mode, loopback socket
// check, fail-closed on a missing peer) is the engine's and is covered there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";

describe("admin gate — token mode renders the github envelope", () => {
  beforeEach(() => {
    process.env.TWIN_ADMIN_TOKEN = "super-secret-admin-token";
  });
  afterEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("rejects missing X-Admin-Token with the Forbidden message", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Forbidden");
  });

  it("rejects wrong X-Admin-Token", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "wrong" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe("Forbidden");
  });

  it("accepts the correct X-Admin-Token (case-insensitive header)", async () => {
    const app = createGitHubCloneApp();
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
  // covers the gate itself, so it takes the opt-in away first.
  const prevOptIn = process.env.TWIN_ADMIN_ALLOW_NO_PEER;
  beforeEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
    delete process.env.TWIN_ADMIN_ALLOW_NO_PEER;
  });
  afterEach(() => {
    if (prevOptIn === undefined) delete process.env.TWIN_ADMIN_ALLOW_NO_PEER;
    else process.env.TWIN_ADMIN_ALLOW_NO_PEER = prevOptIn;
  });

  it("rejects in-process requests (no client ip) outside production — NODE_ENV is not a boundary (F-1804)", async () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const app = createGitHubCloneApp();
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message: string }).message).toBe("Forbidden");
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });

  it("admits in-process requests only under TWIN_ADMIN_ALLOW_NO_PEER=1", async () => {
    process.env.TWIN_ADMIN_ALLOW_NO_PEER = "1";
    const app = createGitHubCloneApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("rejects in-process requests with unknown client ip in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = createGitHubCloneApp();
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message: string }).message).toBe("Forbidden");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
