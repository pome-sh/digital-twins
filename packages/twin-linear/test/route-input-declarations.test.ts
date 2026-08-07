// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — twin-linear's declared input surface.
//
// Linear is the twin the other four were rebuilt to resemble: its OPERATION
// arguments were already readable with zero transcription, out of the executable
// schema `/graphql` runs every request against. What was NOT declared was the
// HTTP transport around it — the GraphQL envelope and the four OAuth endpoints —
// and this suite covers both halves: that the transport now refuses an input it
// does not name, and that the argument projection is the schema rather than a
// second description of it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { diffRegisteredRoutes } from "@pome-sh/sdk/route-inputs";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  createLinearTwinApp,
} from "../src/index.js";
import { linearGraphqlArgumentSurfaces } from "../src/graphql/argument-surface.js";
import { linearGraphQLSchema } from "../src/graphql/schema.js";
import { LINEAR_ROUTES, LINEAR_ROUTE_INPUTS } from "../src/route-inputs.js";
import { registerGraphqlRoutes } from "../src/graphql/routes.js";
import { registerOAuthRoutes } from "../src/oauth/routes.js";

const SECRET = "linear-route-inputs-test-secret-32ch";
const previousSecret = process.env.TWIN_AUTH_SECRET;
let jwt: string;
let app: ReturnType<typeof createLinearTwinApp>;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  jwt = await sign(
    {
      sid: DEFAULT_LINEAR_SID,
      team_id: "tm_linear",
      linear_email: DEFAULT_LINEAR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
  app = createLinearTwinApp();
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

/** The probe name: something no vendor and no twin declares anywhere. */
const UNDECLARED = "pome_undeclared_probe";

/** A URL for a declaration, with its path params filled in plausibly. */
function urlFor(path: string): string {
  const filled = path.replace(/:([A-Za-z0-9_]+)/g, "placeholder");
  // `/graphql` is session-mounted (and also at root); OAuth is mounted publicly
  // ahead of bearerAuth. Both are reachable at root on this app.
  return `http://twin.invalid${filled}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${jwt}`, ...extra };
}

describe("route input declarations", () => {
  it("refuses an input the declaration does not name", async () => {
    expect(LINEAR_ROUTE_INPUTS.length).toBeGreaterThan(0);

    for (const declaration of LINEAR_ROUTE_INPUTS) {
      // ── query ──────────────────────────────────────────────────────────────
      const queryUrl = `${urlFor(declaration.path)}?${UNDECLARED}=x`;
      const viaQuery = await app.request(queryUrl, {
        method: declaration.method === "ALL" ? "GET" : declaration.method,
        headers: authHeaders(
          declaration.bodyEncoding === "none"
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }
        ),
        ...(declaration.bodyEncoding === "none" ? {} : { body: "" }),
      });
      expect(
        viaQuery.status,
        `${declaration.surface} accepted an undeclared query key`
      ).toBeGreaterThanOrEqual(400);
      expect(viaQuery.status, `${declaration.surface} answered 501`).not.toBe(501);

      // ── body ───────────────────────────────────────────────────────────────
      if (declaration.bodyEncoding === "none") continue;
      const viaBody = await app.request(urlFor(declaration.path), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
        body: new URLSearchParams({ [UNDECLARED]: "x" }).toString(),
      });
      expect(
        viaBody.status,
        `${declaration.surface} accepted an undeclared body key`
      ).toBeGreaterThanOrEqual(400);
      expect(viaBody.status, `${declaration.surface} answered 501`).not.toBe(501);
    }
  });

  it("declares every route it registers, and registers every route it declares", () => {
    // A recording router rather than the booted app's route table: the booted
    // app also carries the ENGINE's own surfaces (`/mcp`, `/_pome/*`, `/admin/*`,
    // the catch-all), which are not twin route declarations and would every one
    // of them read as `undeclared`.
    const registered: string[] = [];
    const recorder = Object.fromEntries(
      (["get", "post", "put", "patch", "delete", "all"] as const).map((verb) => [
        verb,
        (path: string) => {
          registered.push(`${verb.toUpperCase()} ${path}`);
        },
      ])
    ) as never;

    registerGraphqlRoutes(recorder, {
      domain: null as never,
      recorder: { handle: () => () => undefined } as never,
      runId: "run",
      twin: "linear",
    });
    registerOAuthRoutes(recorder, null as never);

    expect(diffRegisteredRoutes(registered, LINEAR_ROUTE_INPUTS)).toEqual({
      undeclared: [],
      unmounted: [],
      duplicated: [],
    });
  });

  it("declares the GraphQL envelope, which is transport and not an operation argument", () => {
    // The distinction matters for the published artifact: `query` /
    // `variables` / `operationName` are inputs of the HTTP surface, while an
    // issue's `title` is an argument of a root field. Conflating them would
    // report `undeclaredByVendor` on three names Linear's GraphQL schema has no
    // reason to declare.
    expect(LINEAR_ROUTES.graphqlGet.inputs.map((input) => `${input.location}:${input.name}`)).toEqual([
      "query:operationName",
      "query:query",
      "query:variables",
    ]);
    expect(LINEAR_ROUTES.graphqlPost.inputs.map((input) => `${input.location}:${input.name}`)).toEqual([
      "body:operationName",
      "body:query",
      "body:variables",
    ]);
  });
});

describe("GraphQL argument surface", () => {
  it("is the executable schema, not a description of it", () => {
    const projected = linearGraphqlArgumentSurfaces();
    // Re-derive independently from the schema and compare: if the projection
    // ever became a hand-kept list, this is where it would diverge.
    const expected: string[] = [];
    for (const root of [linearGraphQLSchema.getQueryType(), linearGraphQLSchema.getMutationType()]) {
      if (!root) continue;
      for (const [name, field] of Object.entries(root.getFields())) {
        if (field.args.length > 0) expected.push(`GQL ${name}`);
      }
    }
    expect(projected.map((entry) => entry.surface).sort()).toEqual(expected.sort());
    expect(projected.length).toBeGreaterThan(0);
  });

  it("omits argument-free root fields rather than publishing an empty declaration", () => {
    // pome-cloud counts an empty declaration as `empty-declaration`, a
    // non-result, precisely so comparing nothing against nothing never renders
    // as a pass. `viewer` and `organization` take no arguments.
    const surfaces = new Set(linearGraphqlArgumentSurfaces().map((entry) => entry.surface));
    const argumentFree = Object.entries(linearGraphQLSchema.getQueryType()?.getFields() ?? {})
      .filter(([, field]) => field.args.length === 0)
      .map(([name]) => `GQL ${name}`);
    expect(argumentFree.length).toBeGreaterThan(0);
    for (const surface of argumentFree) expect(surfaces.has(surface)).toBe(false);
    expect(linearGraphqlArgumentSurfaces().every((entry) => entry.inputs.length > 0)).toBe(true);
  });

  it("reports an argument with a default as optional even when its type is non-null", () => {
    // The executor supplies the default, so a request omitting the argument
    // still runs. Reading requiredness off the TYPE alone would over-report it,
    // and `missingRequired` is the field this artifact exists to make live.
    for (const entry of linearGraphqlArgumentSurfaces()) {
      for (const input of entry.inputs) {
        expect(input.location).toBe("argument");
        expect(typeof input.required).toBe("boolean");
      }
    }
    const withDefaults = [linearGraphQLSchema.getQueryType(), linearGraphQLSchema.getMutationType()]
      .flatMap((root) => Object.values(root?.getFields() ?? {}))
      .flatMap((field) => field.args)
      .filter((argument) => argument.defaultValue !== undefined && String(argument.type).endsWith("!"));
    const projected = new Map(
      linearGraphqlArgumentSurfaces().flatMap((entry) =>
        entry.inputs.map((input) => [`${entry.surface}#${input.name}`, input])
      )
    );
    for (const argument of withDefaults) {
      const matches = [...projected.entries()].filter(([key]) => key.endsWith(`#${argument.name}`));
      for (const [, input] of matches) expect(input.required).toBe(false);
    }
  });

  it("spells types the way pome-cloud's GraphQL adapter spells the vendor's", () => {
    // `IssueCreateInput!`, `[String]`, `[ID!]!` — the adapter's own format, so a
    // type comparison would compare like with like the day one is added.
    const types = linearGraphqlArgumentSurfaces().flatMap((entry) =>
      entry.inputs.map((input) => input.type)
    );
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(type).toBeTruthy();
      expect(type).toMatch(/^\[?[A-Za-z_][A-Za-z0-9_]*!?\]?!?$/);
    }
  });
});
