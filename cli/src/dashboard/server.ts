// SPDX-License-Identifier: Apache-2.0
//
// The loopback server behind `Dashboard: http://127.0.0.1:…` (F-1850 · D4).
//
// It exists because a browser's first request for a page is a top-level
// navigation, which cannot carry an `Authorization` header, while everything
// under `/s/:sid/` is bearer-gated. Rather than widen a twin's auth — a
// CONTRACT.md change, with a paired pome-cloud artifact pin — the token stays
// on this side: this process already holds it as a local variable, so the
// browser asks this server and this server asks the twin.
//
// Read-only by construction. There is exactly one data route, it is a GET, and
// it reaches exactly two upstream paths. No route here can write to a twin, so
// there is no write surface on a port every process on the machine can reach.
//
// Three guards, none of them decorative:
//   - bound to 127.0.0.1, never 0.0.0.0
//   - `?k=` — a per-boot random key, required on the data route. The page is
//     handed it in the URL the banner printed (the Jupyter pattern)
//   - Host must be loopback, which is what stops a hostile page from using DNS
//     rebinding to read this port from a tab the user has open elsewhere
//
// The static page is deliberately NOT key-gated: it carries no data, and a
// cross-origin page cannot read the response anyway (no CORS headers are set,
// here or anywhere). Gating it would only mean minting the key into the asset
// URLs, which puts it in the browser history for no gain.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { assetPath } from "../cli/assets.js";
import { buildSnapshot, type DashboardTwin, type TwinReader } from "./snapshot.js";

/** The three files `packages/dashboard`'s vite build emits, by exact name.
 *  A fixed list rather than a directory read: nothing here joins a
 *  caller-supplied path onto a directory, so there is no traversal to get
 *  wrong. `vite.config.ts` pins these names for the same reason. */
const PAGE_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

/**
 * The one inline `<style>` the page is allowed, by exact content.
 *
 * Radix's ScrollArea injects it to hide the native scrollbar under its own, and
 * `style-src 'self'` would refuse it — a doubled scrollbar and a console error.
 * A hash admits exactly this text and nothing else, where `'unsafe-inline'`
 * would admit any style at all. `app.css` carries the same two rules, so a
 * Radix upgrade that rewords them degrades to a console line, never a broken
 * page; `server.test.ts` recomputes this hash from the installed Radix and reds
 * the day they differ.
 */
export const SCROLL_AREA_STYLE_HASH = "sha256-vGQdhYJbTuF+M8iCn1IZCHpdkiICocWHDq4qnQF4Rjw=";

/**
 * Fonts are inlined into app.css as data URIs (see packages/dashboard's
 * vite.config.ts), hence `font-src data:` — the only non-self source here.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'self' '${SCROLL_AREA_STYLE_HASH}'`,
  "font-src data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type DashboardHandle = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

/** Constant-time compare that does not leak the key's length by returning early. */
function keyMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Only a loopback `Host` is served.
 *
 * A browser sends the host it was asked for, so a page at `evil.example` that
 * resolves its own name to 127.0.0.1 arrives here with `Host: evil.example` and
 * is refused — which is the whole of the DNS-rebinding defence. A port suffix
 * is allowed because that is how browsers send it.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

export function createDashboardApp(options: {
  key: string;
  twins: readonly DashboardTwin[];
  read?: TwinReader;
}): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!isLoopbackHost(c.req.header("host"))) {
      return c.text("This dashboard serves 127.0.0.1 only.", 403);
    }
    await next();
  });

  app.get("/api/snapshot", async (c) => {
    if (!keyMatches(c.req.query("k") ?? "", options.key)) {
      // No hint about what a right key looks like, and the same answer whether
      // the key is absent or wrong.
      return c.json({ error: "not authorized for this dashboard" }, 401);
    }
    const snapshot = await buildSnapshot(options.twins, options.read);
    // A poll is only ever about this instant; a cached one would show a tape
    // that has already moved on.
    c.header("cache-control", "no-store");
    return c.json(snapshot);
  });

  app.get("*", (c) => {
    const wanted = PAGE_FILES[new URL(c.req.url).pathname];
    if (wanted === undefined) return c.text("Not found.", 404);
    try {
      const body = readFileSync(assetPath("dashboard", wanted.file));
      c.header("content-type", wanted.type);
      c.header("cache-control", "no-store");
      // The page loads nothing but itself: no CDN, no font request, no
      // analytics. Saying so in a header means a mistake later fails visibly in
      // the console rather than quietly phoning somewhere.
      c.header("content-security-policy", DASHBOARD_CSP);
      return c.body(body as unknown as ArrayBuffer);
    } catch (err) {
      // `assetPath` throws when the page was never built. Say which command
      // fixes it rather than leaving a blank tab.
      return c.text(
        `The dashboard page is not in this install.\n${(err as Error).message}\n` +
          "Build it with `npm run build -w @pome-sh/dashboard`.",
        500,
      );
    }
  });

  return app;
}

/**
 * Bind the dashboard on loopback and hand back its URL.
 *
 * Port 0 by default. `chooseStandalonePorts` refuses an ephemeral port for a
 * TWIN because its URL has to be discoverable from outside the process (the
 * status file, the printed env lines); neither is true here — this URL is
 * printed once, in the banner, and nothing else consumes it. A fixed default
 * would instead collide across the five `pome twin start` processes
 * `contract/cli-start.test.mjs` spawns in CI.
 */
export async function startDashboard(options: {
  twins: readonly DashboardTwin[];
  port?: number;
  read?: TwinReader;
}): Promise<DashboardHandle> {
  const key = randomBytes(16).toString("hex");
  const app = createDashboardApp({ key, twins: options.twins, read: options.read });

  const server: ServerType = serve({
    fetch: app.fetch,
    port: options.port ?? 0,
    hostname: "127.0.0.1",
  });
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `pome twin start: dashboard port ${options.port} is already in use — pass --dashboard-port <port>, or --no-dashboard.`,
            )
          : err,
      );
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      // Without a listener at all, a post-bind error is a fatal uncaught
      // exception. The twin is the point; a dead dashboard must not take it
      // down with a stack trace.
      server.on("error", (err) => console.error(`pome twin start: dashboard error: ${err}`));
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}/?k=${key}`,
    close: async () => {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
