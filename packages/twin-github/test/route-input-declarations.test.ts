// SPDX-License-Identifier: Apache-2.0
// The twin's declared route input surface, driven over the real HTTP wire.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  diffRegisteredRoutes,
  type RouteInputDeclaration,
  type UndeclaredDisposition,
} from "@pome-sh/sdk/route-inputs";
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

/** the ruling for this twin: real GitHub answers an unknown query parameter and an
 *  unknown top-level body key exactly as it answers the request without them. */
const RULED: UndeclaredDisposition = "ignore";

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

/** The pattern with every `:param` (and any `{regex}` tail) and every `*` filled in. */
function concretePath(declaration: RouteInputDeclaration): string {
  return declaration.path
    .replace(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?/g, (_whole, param: string) => PATH_SAMPLES[param] ?? "x")
    .replaceAll("*", "README.md");
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
): Promise<{ status: number; text: string }> {
  const request: RequestInit = {
    method: declaration.method,
    headers: { "content-type": "application/json" },
  };
  if (init.body !== undefined) request.body = JSON.stringify(init.body);
  const response = await app.request(
    `${base}${concretePath(declaration)}${init.query ?? ""}`,
    withAuth(token, request)
  );
  return { status: response.status, text: await response.text() };
}

describe("declared route inputs", () => {
  it("is ruled `ignore` on undeclared input, on every route", () => {
    expect(GITHUB_ROUTE_INPUTS.length).toBeGreaterThan(0);
    const dissenting = GITHUB_ROUTE_INPUTS.filter((d) => d.undeclared !== RULED).map(
      (d) => `${d.surface} is '${d.undeclared}'`
    );
    // One ruling per twin, so a route that answered differently from its
    // neighbours would be a per-route decision nobody took — and it would
    // publish an input surface whose meaning changed depending which route you
    // asked. `routeInputDeclarer()` is what makes this hold by construction;
    // this is the assertion that it still does.
    expect(dissenting, `these routes disagree with the twin's heat ruling ('${RULED}')`).toEqual(
      []
    );
  });

  it("serves a request carrying an input the declaration does not name, unchanged", async () => {
    // Two apps driven through the SAME sequence of requests, one of them with
    // the probe added to every call. An input that is genuinely discarded
    // cannot change an answer, so the runs have to agree step for step — on the
    // 404s and 422s the path samples provoke as much as on the 200s, which is a
    // far stronger claim than "the probed call was not a 4xx".
    const plain = createGitHubCloneApp();
    const probed = createGitHubCloneApp();

    for (const declaration of GITHUB_ROUTE_INPUTS) {
      const bare = await probe(plain, declaration, bodyFor(declaration));
      const withQuery = await probe(probed, declaration, {
        query: `?${PROBE}=x`,
        ...bodyFor(declaration),
      });
      // 501 is the engine's unsupported catch-all — it would mean neither
      // request reached this route at all, so their agreeing proved nothing.
      expect(bare.status, `${declaration.surface} answered 501 without the probe`).not.toBe(501);
      expect(
        withQuery.status,
        `${declaration.surface} answered ${withQuery.status} for ?${PROBE}= but ` +
          `${bare.status} without it: ${withQuery.text}`
      ).toBe(bare.status);
      expect(
        withQuery.text,
        `${declaration.surface} mentioned ?${PROBE}= in its answer, so it noticed`
      ).not.toContain(PROBE);

      if (declaration.bodyEncoding === "none") continue;

      const bareBody = await probe(plain, declaration, { body: sampleBody(declaration) });
      const probedBody = await probe(probed, declaration, {
        body: { ...sampleBody(declaration), [PROBE]: "x" },
      });
      expect(bareBody.status, `${declaration.surface} answered 501 without the probe`).not.toBe(501);
      expect(
        probedBody.status,
        `${declaration.surface} answered ${probedBody.status} for an undeclared body key but ` +
          `${bareBody.status} without it: ${probedBody.text}`
      ).toBe(bareBody.status);
      expect(
        probedBody.text,
        `${declaration.surface} mentioned the undeclared body key in its answer`
      ).not.toContain(PROBE);
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
