// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — the twin's declared route input surface, driven over the real HTTP
// wire.
//
// Both assertions here are about the two failure modes the declaration
// mechanism exists to make structurally impossible, not about any one route:
//
//   1. A handler can never see an input its declaration does not name. Probed
//      through `app.request` rather than `declaration.parse` in isolation,
//      because "the parser refuses it" and "the handler cannot see it" are
//      different claims and only the second one matters.
//   2. The declared set and the registered set are the same set. The method and
//      path cannot drift (the route is mounted FROM the declaration), but
//      EXISTENCE can — a route registered without a declaration would be a hole
//      in the published surface with every other check green.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { diffRegisteredRoutes, type RouteInputDeclaration } from "@pome-sh/sdk/route-inputs";
import { GITHUB_ROUTE_INPUTS } from "../src/route-inputs.js";
import { registerGitHubRoutes } from "../src/routes.js";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

/** A query/body key no GitHub surface has ever declared. */
const PROBE = "pome_undeclared_probe";

/**
 * A value per path param that satisfies that param's own schema, so the probe
 * is refused for the reason under test rather than because the path was
 * rejected first. Anything unlisted falls back to a plain segment.
 */
const PATH_SAMPLES: Record<string, string> = {
  owner: "acme",
  repo: "api",
  username: "alice",
  name: "bug",
  ref: "main",
  sha: "a".repeat(40),
  basehead: "main...main",
  number: "1",
  comment_id: "1",
};

/** The pattern with every `:param` (and any `{regex}` tail) and `*` filled in. */
function concretePath(declaration: RouteInputDeclaration): string {
  return declaration.path
    .replace(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?/g, (_whole, param: string) => PATH_SAMPLES[param] ?? "x")
    .replace("*", "README.md");
}

const SAMPLE_BY_TYPE: Record<string, unknown> = {
  string: "x",
  integer: 1,
  number: 1,
  boolean: true,
  array: ["x"],
  object: {},
};

/** A body carrying every REQUIRED declared input, so it looks like a real call. */
function sampleBody(declaration: RouteInputDeclaration): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const input of declaration.inputs) {
    if (input.location !== "body" || !input.required) continue;
    body[input.name] = SAMPLE_BY_TYPE[input.type ?? "string"] ?? "x";
  }
  return body;
}

async function probe(
  app: Hono,
  declaration: RouteInputDeclaration,
  init: { query?: string; body?: unknown }
): Promise<{ status: number; field: string | undefined }> {
  const request: RequestInit = {
    method: declaration.method,
    headers: { "content-type": "application/json" },
  };
  if (init.body !== undefined) request.body = JSON.stringify(init.body);
  const response = await app.request(
    `${base}${concretePath(declaration)}${init.query ?? ""}`,
    withAuth(token, request)
  );
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as { errors?: Array<{ field?: string }> }) : null;
  return { status: response.status, field: parsed?.errors?.[0]?.field };
}

describe("declared route inputs (F-1179)", () => {
  it("refuses an input the declaration does not name", async () => {
    // One app for every probe: a refused request never reaches the domain, so
    // there is no state to isolate between them.
    const app = createGitHubCloneApp();

    for (const declaration of GITHUB_ROUTE_INPUTS) {
      const query = await probe(app, declaration, { query: `?${PROBE}=x`, ...bodyFor(declaration) });
      // 501 is the engine's unsupported catch-all — it would mean the probe
      // never reached this route at all, so the refusal proved nothing.
      expect(query.status, `${declaration.surface} answered 501 for ?${PROBE}=`).not.toBe(501);
      expect(query.status, `${declaration.surface} did not refuse ?${PROBE}=`).toBeGreaterThanOrEqual(400);
      expect(query.status, `${declaration.surface} did not refuse ?${PROBE}=`).toBeLessThan(500);
      expect(query.field, `${declaration.surface} refused ?${PROBE}= for another reason`).toBe(PROBE);

      if (declaration.bodyEncoding === "none") continue;

      const body = await probe(app, declaration, {
        body: { ...sampleBody(declaration), [PROBE]: "x" },
      });
      expect(body.status, `${declaration.surface} answered 501 for an undeclared body key`).not.toBe(501);
      expect(
        body.status,
        `${declaration.surface} did not refuse the undeclared body key ${PROBE}`
      ).toBeGreaterThanOrEqual(400);
      expect(body.status, `${declaration.surface} 5xx'd on an undeclared body key`).toBeLessThan(500);
      expect(body.field, `${declaration.surface} refused ${PROBE} for another reason`).toBe(PROBE);
    }
  });

  it("declares every route it registers, and registers every route it declares", () => {
    // Read off a recording router rather than hono's route table: the booted
    // app's table also carries the engine's own session routes (`/mcp`,
    // `/_pome/*`, the `*` catch-all), which are not this twin's surface and
    // would show up as `undeclared`. The registrar is the thing under test.
    const registered = surfacesFromRegistrar();

    expect(diffRegisteredRoutes(registered, GITHUB_ROUTE_INPUTS)).toEqual({
      undeclared: [],
      unmounted: [],
      duplicated: [],
    });

    // …and every declaration really is mounted on the booted app, session
    // prefix included, so the diff above is not comparing two lists that agree
    // with each other and with nothing that serves traffic.
    const mounted = new Set(createGitHubCloneApp().routes.map((route) => `${route.method} ${route.path}`));
    for (const declaration of GITHUB_ROUTE_INPUTS) {
      expect(
        mounted.has(`${declaration.method} ${base.replace(TEST_SID, ":sid")}${declaration.path}`),
        `${declaration.surface} is declared but the booted app does not serve it`
      ).toBe(true);
    }
  });
});

/** GET/DELETE-with-no-body routes must not carry one; `app.request` rejects it. */
function bodyFor(declaration: RouteInputDeclaration): { body?: unknown } {
  return declaration.bodyEncoding === "none" ? {} : { body: sampleBody(declaration) };
}

/**
 * Every `session.<verb>(path)` call `registerGitHubRoutes` makes, as surfaces.
 *
 * The domain and recorder are stubs because nothing is served: registration
 * happens at call time and the handlers are never invoked.
 */
function surfacesFromRegistrar(): string[] {
  const seen: string[] = [];
  const record = (method: string) => (path: string) => {
    seen.push(`${method} ${path}`);
  };
  const router = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
    all: record("ALL"),
  } as unknown as Hono;
  const context = {
    domain: {},
    recorder: { handle: () => () => undefined },
    runId: "test",
    twin: "github",
  } as unknown as Parameters<typeof registerGitHubRoutes>[1];
  registerGitHubRoutes(router, context);
  return seen;
}
