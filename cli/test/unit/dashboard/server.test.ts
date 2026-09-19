// SPDX-License-Identifier: Apache-2.0
//
// The dashboard's three guards, and the shape of what it serves (F-1850 · D4).
//
// This server listens on a port every process on the machine can reach and
// hands back a twin's whole state, so the guards are not decoration and are
// asserted here rather than left to a manual curl. Driven through
// `app.request()` — no socket, no port, no flake.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CSP,
  SCROLL_AREA_STYLE_HASH,
  createDashboardApp,
} from "../../../src/dashboard/server.js";
import type { DashboardTwin, TwinReader } from "../../../src/dashboard/snapshot.js";

const KEY = "0123456789abcdef0123456789abcdef";

const TWIN: DashboardTwin = {
  name: "github",
  restUrl: "http://127.0.0.1:3441/s/standalone",
  mcpUrl: "http://127.0.0.1:3441/s/standalone/mcp",
  token: "eyJhbGciOiJIUzI1NiJ9.test-token",
  envName: "GITHUB",
  initialState: { repositories: [{ full_name: "acme/api", issues: [] }] },
};

/** A twin that answers, without one existing. */
const answers: TwinReader = async () => ({
  events: [],
  state: { repositories: [{ full_name: "acme/api", issues: [] }] },
});

/** A twin that has gone away — what Ctrl-C looks like from here. */
const silent: TwinReader = async () => null;

function app(read: TwinReader = answers) {
  return createDashboardApp({ key: KEY, twins: [TWIN], read });
}

const loopback = { headers: { host: "127.0.0.1:61953" } };

describe("the key gate", () => {
  it("refuses a request with no key", async () => {
    const res = await app().request("/api/snapshot", loopback);
    expect(res.status).toBe(401);
  });

  it("refuses a wrong key, and a right one of the wrong length, the same way", async () => {
    const wrong = await app().request(`/api/snapshot?k=${"f".repeat(KEY.length)}`, loopback);
    const short = await app().request(`/api/snapshot?k=${KEY.slice(0, 8)}`, loopback);
    expect([wrong.status, short.status]).toEqual([401, 401]);
    // No hint about what a right key looks like, and no difference between
    // "absent" and "wrong" for something guessing.
    expect(await wrong.json()).toEqual(await short.json());
  });

  it("serves the snapshot to the right key", async () => {
    const res = await app().request(`/api/snapshot?k=${KEY}`, loopback);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the host gate", () => {
  it("refuses a name that is not loopback, which is the DNS-rebinding case", async () => {
    // A page at evil.example that resolves its own name to 127.0.0.1 arrives
    // with its own Host, and is refused before the key is even read.
    const res = await app().request(`/api/snapshot?k=${KEY}`, {
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts the names a browser really sends for loopback", async () => {
    for (const host of ["127.0.0.1:61953", "localhost:61953", "127.0.0.1", "[::1]:61953"]) {
      const res = await app().request(`/api/snapshot?k=${KEY}`, { headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it("refuses a request with no Host at all", async () => {
    const res = await app().request(`/api/snapshot?k=${KEY}`, { headers: {} });
    expect(res.status).toBe(403);
  });
});

describe("read-only by construction", () => {
  it("has no method but GET on the data route", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app().request(`/api/snapshot?k=${KEY}`, { method, ...loopback });
      expect(res.status, method).toBe(404);
    }
  });

  it("serves no path outside the three files the build emits", async () => {
    for (const path of ["/../../package.json", "/app.js.map", "/assets/app.js", "/.env"]) {
      const res = await app().request(path, loopback);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("the content security policy", () => {
  it("admits Radix's ScrollArea style by the hash of what the installed Radix injects", () => {
    // Read the injected text out of the Radix the dashboard actually builds
    // with, so an upgrade that rewords it reds here instead of shipping a
    // page whose scrollbar style the browser refuses.
    const require = createRequire(new URL("../../../../packages/dashboard/package.json", import.meta.url));
    const radix = readFileSync(
      require.resolve("@radix-ui/react-scroll-area").replace(/index\.js$/, "index.mjs"),
      "utf8",
    );
    const injected = /__html: `([^`]*)`/.exec(radix)?.[1];
    expect(injected, "Radix no longer injects an inline style this test can find").toBeTruthy();
    const hash = `sha256-${createHash("sha256").update(injected!).digest("base64")}`;
    expect(SCROLL_AREA_STYLE_HASH).toBe(hash);
    expect(DASHBOARD_CSP).toContain(`'${hash}'`);
  });

  it("allows nothing inline but that one style, and no remote origin at all", () => {
    expect(DASHBOARD_CSP).not.toContain("unsafe-inline");
    expect(DASHBOARD_CSP).not.toContain("unsafe-eval");
    expect(DASHBOARD_CSP).not.toMatch(/https?:/);
  });
});

describe("what the snapshot carries", () => {
  it("names the twin, its world, and a connect block with the token masked", async () => {
    const res = await app().request(`/api/snapshot?k=${KEY}`, loopback);
    const body = (await res.json()) as {
      twins: Array<{
        name: string;
        reachable: boolean;
        connect: {
          exportLine: string;
          exportLineMasked: string;
          mcpJson: string;
          claudeCode: string;
          claudeCodeMasked: string;
          codexToml: string;
        };
        world: Array<{ path: string }>;
      }>;
    };
    const twin = body.twins[0]!;

    expect(twin.name).toBe("github");
    expect(twin.reachable).toBe(true);
    expect(twin.world.map((entry) => entry.path)).toContain("repositories[acme/api].issues");

    // The export line is the only block holding a credential, and the masked
    // form must not leak it — that is what makes a screenshot of this page safe.
    expect(twin.connect.exportLine).toContain(TWIN.token);
    expect(twin.connect.exportLineMasked).not.toContain(TWIN.token);
    expect(twin.connect.exportLineMasked).toContain("POME_AUTH_TOKEN=");
    // The .mcp.json stanza references the variable rather than carrying a token.
    expect(twin.connect.mcpJson).toContain("${POME_AUTH_TOKEN}");
    expect(twin.connect.mcpJson).not.toContain(TWIN.token);
    // `claude mcp add` inlines the bearer, so its masked form must not leak it.
    expect(twin.connect.claudeCode).toContain(TWIN.token);
    expect(twin.connect.claudeCodeMasked).not.toContain(TWIN.token);
    expect(twin.connect.claudeCodeMasked).toMatch(/^claude mcp add --transport http pome-github /);
    // Codex names the variable, never the value.
    expect(twin.connect.codexToml).toContain('bearer_token_env_var = "POME_AUTH_TOKEN"');
    expect(twin.connect.codexToml).not.toContain(TWIN.token);
  });

  it("reports a twin that stopped answering rather than failing the whole poll", async () => {
    const res = await app(silent).request(`/api/snapshot?k=${KEY}`, loopback);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { twins: Array<{ reachable: boolean; entries: unknown[] }> };
    // Ctrl-C is the normal end of a session, not an error the page renders as
    // a stack trace.
    expect(body.twins[0]).toMatchObject({ reachable: false, entries: [] });
  });
});
