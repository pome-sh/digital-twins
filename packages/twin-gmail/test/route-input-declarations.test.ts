// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — the Gmail twin's declared route input surface, driven over the real
// HTTP wire.
//
// Both assertions are about the two failure modes the declaration mechanism
// exists to make structurally impossible, not about any one route:
//
//   1. A handler can never see an input its declaration does not name. Probed
//      through `app.request` rather than `declaration.parse` in isolation,
//      because "the parser refuses it" and "the handler cannot see it" are
//      different claims and only the second one matters.
//   2. The declared set and the registered set are the same set. Method and
//      path cannot drift (the route is mounted FROM the declaration), but
//      EXISTENCE can — a route registered without a declaration would be a hole
//      in the published surface with every other check green.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  diffRegisteredRoutes,
  type DeclarableRouter,
  type RouteInputDeclaration,
} from "@pome-sh/sdk/route-inputs";
import { GMAIL_ROUTE_INPUTS } from "../src/route-inputs.js";
import { registerGmailRoutes } from "../src/rest-routes.js";
import { createGmailTwinApp, openGmailTwinDatabase, type GmailStateSeed } from "../src/index.js";

const SID = "gmail-declarations";
const SECRET = "gmail-declarations-secret";
const EMAIL = "pome-agent@pome-twin.test";
const base = `/s/${SID}`;
const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    { sid: SID, team_id: "team_test", gmail_email: EMAIL, exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET
  );
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function boot(): Hono {
  const seed: GmailStateSeed = {
    primaryMailbox: { email: EMAIL, displayName: "Pome Agent" },
    clock: "2025-01-01T00:00:00.000Z",
  };
  return createGmailTwinApp({ db: openGmailTwinDatabase(":memory:"), seed, runId: "declarations" });
}

/** A query/body key no Gmail surface has ever declared. */
const PROBE = "pome_undeclared_probe";

/**
 * A value per path param that satisfies that param's own schema, so the probe
 * is refused for the reason under test rather than because the path was
 * rejected first.
 */
const PATH_SAMPLES: Record<string, string> = {
  userId: "me",
  id: "probe_id",
  messageId: "probe_message",
  forwardingEmail: "forward@example.test",
  sendAsEmail: "alias@example.test",
};

function concretePath(declaration: RouteInputDeclaration): string {
  return declaration.path.replace(
    /:([A-Za-z0-9_]+)/g,
    (_whole, param: string) => PATH_SAMPLES[param] ?? "x"
  );
}

/**
 * The routes `kit.unsupported` mounts — resumable uploads and the two Pub/Sub
 * operations. They answer 501 without parsing, on purpose: "this operation is
 * not implemented" is the honest answer to a well-formed `users.watch` body,
 * and parsing first would turn it into a 400 about a parameter instead. This
 * predicate IS that design rule, so a new `kit.unsupported` route outside it
 * reds this test rather than quietly joining the exemption.
 */
function refusesWithoutParsing(declaration: RouteInputDeclaration): boolean {
  return (
    declaration.path.startsWith("/resumable/") ||
    declaration.path.endsWith("/watch") ||
    declaration.path.endsWith("/stop")
  );
}

/** Values that satisfy a declared body input, including the nested ones. */
const BODY_SAMPLES: Record<string, unknown> = {
  raw: "cmF3",
  message: { raw: "cmF3" },
  ids: ["probe_id"],
  name: "Probe label",
  criteria: {},
  action: {},
};

const SAMPLE_BY_TYPE: Record<string, unknown> = {
  string: "x",
  integer: 1,
  number: 1,
  boolean: true,
  array: ["x"],
  object: {},
};

/** A body carrying every REQUIRED declared input, so the probe looks like a real call. */
function sampleBody(declaration: RouteInputDeclaration): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const input of declaration.inputs) {
    if (input.location !== "body" || !input.required) continue;
    body[input.name] = BODY_SAMPLES[input.name] ?? SAMPLE_BY_TYPE[input.type ?? "string"] ?? "x";
  }
  return body;
}

type Answer = { status: number; message: string };

async function probe(
  app: Hono,
  declaration: RouteInputDeclaration,
  init: { query?: string; body?: unknown }
): Promise<Answer> {
  const request: RequestInit = {
    method: declaration.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
  if (init.body !== undefined) request.body = JSON.stringify(init.body);
  const response = await app.request(
    `${base}${concretePath(declaration)}${init.query ?? ""}`,
    request
  );
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as { error?: { message?: string } }) : null;
  return { status: response.status, message: parsed?.error?.message ?? "" };
}

describe("declared route inputs (F-1179)", () => {
  it("refuses an input the declaration does not name", async () => {
    // One app for every probe: a refused request never reaches the domain, so
    // there is no state to isolate between them.
    const app = boot();

    for (const declaration of GMAIL_ROUTE_INPUTS) {
      const hasBody = declaration.bodyEncoding !== "none";
      const query = await probe(app, declaration, {
        query: `?${PROBE}=x`,
        ...(hasBody ? { body: sampleBody(declaration) } : {}),
      });

      if (refusesWithoutParsing(declaration)) {
        expect(query.status, `${declaration.surface} should answer its own 501`).toBe(501);
        // …its OWN 501, not the engine's unsupported-route catch-all, which
        // would mean the probe never reached this route at all.
        expect(query.message, `${declaration.surface} hit the engine catch-all`).not.toMatch(
          /^Unsupported Gmail twin route/
        );
        continue;
      }

      expect(query.status, `${declaration.surface} answered 501 for ?${PROBE}=`).not.toBe(501);
      expect(query.status, `${declaration.surface} did not refuse ?${PROBE}=`).toBeGreaterThanOrEqual(400);
      expect(query.status, `${declaration.surface} 5xx'd on ?${PROBE}=`).toBeLessThan(500);
      expect(query.message, `${declaration.surface} refused ?${PROBE}= for another reason`).toBe(
        `Invalid query parameter: ${PROBE}`
      );

      if (!hasBody) continue;

      const body = await probe(app, declaration, {
        body: { ...sampleBody(declaration), [PROBE]: "x" },
      });
      expect(body.status, `${declaration.surface} answered 501 for an undeclared body key`).not.toBe(501);
      expect(
        body.status,
        `${declaration.surface} did not refuse the undeclared body key ${PROBE}`
      ).toBeGreaterThanOrEqual(400);
      expect(body.status, `${declaration.surface} 5xx'd on an undeclared body key`).toBeLessThan(500);
      expect(body.message, `${declaration.surface} refused ${PROBE} for another reason`).toBe(
        `Invalid body parameter: ${PROBE}`
      );
    }
  });

  it("declares every route it registers, and registers every route it declares", () => {
    // Read off a recording router rather than hono's route table: the booted
    // app's table also carries the engine's own session routes (`/mcp`,
    // `/_pome/*`, the `*` catch-all), which are not this twin's surface and
    // would show up as `undeclared`. The registrar is the thing under test.
    expect(diffRegisteredRoutes(surfacesFromRegistrar(), GMAIL_ROUTE_INPUTS)).toEqual({
      undeclared: [],
      unmounted: [],
      duplicated: [],
    });

    // …and every declaration really is mounted on the booted app, session
    // prefix included, so the diff above is not comparing two lists that agree
    // with each other and with nothing that serves traffic.
    const mounted = new Set(boot().routes.map((route) => `${route.method} ${route.path}`));
    for (const declaration of GMAIL_ROUTE_INPUTS) {
      expect(
        mounted.has(`${declaration.method} /s/:sid${declaration.path}`),
        `${declaration.surface} is declared but the booted app does not serve it`
      ).toBe(true);
    }
  });
});

/**
 * Every `app.<verb>(path)` call `registerGmailRoutes` makes, as surfaces.
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
  } as unknown as DeclarableRouter;
  const context = {
    domain: {},
    recorder: { handle: () => () => undefined },
    runId: "test",
    twin: "gmail",
  } as unknown as Parameters<typeof registerGmailRoutes>[1];
  registerGmailRoutes(router, context);
  return seen;
}
