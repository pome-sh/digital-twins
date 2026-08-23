// SPDX-License-Identifier: Apache-2.0
// Moved from `packages/adapter-claude-sdk/test/fetch.test.ts` — the fetch hook is now
// wire's, so its guard is too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCorrelation } from "../src/correlation/context.js";
import {
  CORRELATION_HEADER,
  getCorrelationAllowlist,
  installCorrelationFetchHook,
  setCorrelationAllowlist,
  uninstallCorrelationFetchHook,
} from "../src/correlation/fetch.js";

let originalFetch: typeof globalThis.fetch;
let captured: Array<{ url: string; headers: Record<string, string> }>;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k.toLowerCase()] = v;
    } else if (h) {
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = (h as Record<string, string>)[k]!;
    }
    captured.push({ url, headers });
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  uninstallCorrelationFetchHook();
  globalThis.fetch = originalFetch;
});

describe("installCorrelationFetchHook", () => {
  it("replaces globalThis.fetch", () => {
    const before = globalThis.fetch;
    installCorrelationFetchHook({ twinHosts: [] });
    expect(globalThis.fetch).not.toBe(before);
  });

  it("uninstallCorrelationFetchHook restores the prior fetch", () => {
    const before = globalThis.fetch;
    installCorrelationFetchHook({ twinHosts: [] });
    uninstallCorrelationFetchHook();
    expect(globalThis.fetch).toBe(before);
  });

  it("a second install is idempotent (wraps once)", () => {
    installCorrelationFetchHook({ twinHosts: [] });
    const first = globalThis.fetch;
    installCorrelationFetchHook({ twinHosts: [] });
    expect(globalThis.fetch).toBe(first);
  });

  it("a second install still updates the allowlist", () => {
    installCorrelationFetchHook({ twinHosts: [] });
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    expect(getCorrelationAllowlist()).toEqual(["http://127.0.0.1:3333"]);
  });

  it("injects x-pome-correlation-id header for allowlisted host inside a correlation scope", async () => {
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await withCorrelation("tlc_abc", async () => {
      await globalThis.fetch("http://127.0.0.1:3333/v1/repos");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_abc");
  });

  it("does NOT inject header for non-allowlisted host (e.g. anthropic.com)", async () => {
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await withCorrelation("tlc_abc", async () => {
      await globalThis.fetch("https://api.anthropic.com/v1/messages");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBeUndefined();
  });

  it("does NOT inject header outside any correlation scope", async () => {
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await globalThis.fetch("http://127.0.0.1:3333/v1/repos");
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBeUndefined();
  });

  it("matches the allowlist by URL origin (not exact path)", async () => {
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await withCorrelation("tlc_x", async () => {
      await globalThis.fetch("http://127.0.0.1:3333/anything/deep/path?q=1");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_x");
  });

  it("preserves user-set headers when injecting", async () => {
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await withCorrelation("tlc_x", async () => {
      await globalThis.fetch("http://127.0.0.1:3333/foo", {
        method: "POST",
        headers: { authorization: "Bearer abc", "content-type": "application/json" },
        body: JSON.stringify({ x: 1 }),
      });
    });
    expect(captured[0]!.headers["authorization"]).toBe("Bearer abc");
    expect(captured[0]!.headers["content-type"]).toBe("application/json");
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_x");
  });

  it("supports URL object input", async () => {
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await withCorrelation("tlc_url", async () => {
      await globalThis.fetch(new URL("http://127.0.0.1:3333/v1/anything"));
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBe("tlc_url");
  });

  it("empty allowlist injects nothing even if inside a correlation scope", async () => {
    installCorrelationFetchHook({ twinHosts: [] });
    await withCorrelation("tlc_x", async () => {
      await globalThis.fetch("http://127.0.0.1:3333/foo");
    });
    expect(captured[0]!.headers[CORRELATION_HEADER]).toBeUndefined();
  });

  it("carries the SAME id across two microtask hops and a parallel fan-out", async () => {
    // The silent-failure mode, at the level of the neutral core: an ALS store that did
    // not survive chained awaits produced an absent header while every "header.
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await withCorrelation("tlc_hops", async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await Promise.all([
        globalThis.fetch("http://127.0.0.1:3333/v1/a"),
        globalThis.fetch("http://127.0.0.1:3333/v1/b"),
      ]);
    });
    expect(captured).toHaveLength(2);
    for (const call of captured) {
      expect(call.headers[CORRELATION_HEADER]).toBe("tlc_hops");
    }
  });

  it("concurrent scopes each stamp their OWN id", async () => {
    // The race the ALS store exists to prevent: with a module-level "current id"
    // both requests would carry whichever scope started last.
    installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] });
    await Promise.all([
      withCorrelation("tlc_first", async () => {
        await new Promise((r) => setTimeout(r, 4));
        await globalThis.fetch("http://127.0.0.1:3333/first");
      }),
      withCorrelation("tlc_second", async () => {
        await new Promise((r) => setTimeout(r, 1));
        await globalThis.fetch("http://127.0.0.1:3333/second");
      }),
    ]);
    const byPath = new Map(captured.map((c) => [new URL(c.url).pathname, c]));
    expect(byPath.get("/first")!.headers[CORRELATION_HEADER]).toBe("tlc_first");
    expect(byPath.get("/second")!.headers[CORRELATION_HEADER]).toBe("tlc_second");
  });
});

describe("setCorrelationAllowlist / getCorrelationAllowlist", () => {
  it("normalizes entries to origins and drops the path", () => {
    setCorrelationAllowlist(["http://127.0.0.1:3333/v1/repos"]);
    expect(getCorrelationAllowlist()).toEqual(["http://127.0.0.1:3333"]);
  });

  it("drops unparseable entries instead of throwing (they arrive from env vars)", () => {
    setCorrelationAllowlist(["not a url", "", "https://twin.example.com"]);
    expect(getCorrelationAllowlist()).toEqual(["https://twin.example.com"]);
  });

  it("uninstall clears the allowlist", () => {
    installCorrelationFetchHook({ twinHosts: ["https://twin.example.com"] });
    uninstallCorrelationFetchHook();
    expect(getCorrelationAllowlist()).toEqual([]);
  });
});
