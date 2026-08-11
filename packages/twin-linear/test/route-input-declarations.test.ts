// SPDX-License-Identifier: Apache-2.0
//
// F-1179 / F-1372 — twin-linear's declared input surface.
//
// Linear is the twin the other four were rebuilt to resemble: its OPERATION
// arguments were already readable with zero transcription, out of the executable
// schema `/graphql` runs every request against. What was NOT declared was the
// HTTP transport around it — the GraphQL envelope and the four OAuth endpoints —
// and this suite covers both halves: that the transport handles an input it
// does not name the way F-1372 measured Linear handling one, and that the
// argument projection is the schema rather than a second description of it.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { diffRegisteredRoutes, type UndeclaredDisposition } from "@pome-sh/sdk/route-inputs";
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

/**
 * F-1372's ruling for this twin: Linear ignores a parameter it does not
 * recognise, on all six routes. Four are OAuth, where RFC 6749 §3.1 and §3.2
 * both say the authorization server "MUST ignore unrecognized request
 * parameters"; real Linear was measured obeying that, and answering `/graphql`
 * identically with and without an unknown envelope or query key, on 2026-08-09
 * (`docs/undeclared-route-inputs.md`).
 */
const RULED: UndeclaredDisposition = "ignore";

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
  it("is ruled `ignore` on undeclared input, on every route", () => {
    expect(LINEAR_ROUTE_INPUTS.length).toBeGreaterThan(0);
    const dissenting = LINEAR_ROUTE_INPUTS.filter((d) => d.undeclared !== RULED).map(
      (d) => `${d.surface} is '${d.undeclared}'`
    );
    expect(dissenting, `these routes disagree with the twin's F-1372 ruling ('${RULED}')`).toEqual(
      []
    );
  });

  it("serves a request carrying an input the declaration does not name, unchanged", async () => {
    expect(LINEAR_ROUTE_INPUTS.length).toBeGreaterThan(0);
    // Two twins taken through the SAME sequence of requests, one of them with
    // the probe added to every one. A parameter that is genuinely ignored
    // cannot change an answer, so the two have to agree request for request —
    // including on the 400s an empty OAuth body earns, which is a much stronger
    // claim than "the probed call was not a 4xx".
    const plain = createLinearTwinApp();
    const probed = createLinearTwinApp();
    const read = async (app: ReturnType<typeof createLinearTwinApp>, url: string, init: RequestInit) =>
      `${(await app.request(url, init)).status}`;

    for (const declaration of LINEAR_ROUTE_INPUTS) {
      const url = urlFor(declaration.path);
      const method = declaration.method === "ALL" ? "GET" : declaration.method;
      const form = declaration.bodyEncoding === "none";
      const init = (): RequestInit => ({
        method,
        headers: authHeaders(form ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(form ? {} : { body: "" }),
      });

      // ── query ──────────────────────────────────────────────────────────────
      expect(
        await read(probed, `${url}?${UNDECLARED}=x`, init()),
        `${declaration.surface} answered differently for an undeclared query key`
      ).toBe(await read(plain, url, init()));

      // ── body ───────────────────────────────────────────────────────────────
      if (form) continue;
      const body = (extra: boolean): RequestInit => ({
        method: "POST",
        headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
        body: extra ? new URLSearchParams({ [UNDECLARED]: "x" }).toString() : "",
      });
      expect(
        await read(probed, url, body(true)),
        `${declaration.surface} answered differently for an undeclared body key`
      ).toBe(await read(plain, url, body(false)));
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
    // `variables` / `operationName` / `extensions` are inputs of the HTTP
    // surface, while an issue's `title` is an argument of a root field.
    // Conflating them would report `undeclaredByVendor` on four names Linear's
    // GraphQL schema has no reason to declare.
    expect(LINEAR_ROUTES.graphqlGet.inputs.map((input) => `${input.location}:${input.name}`)).toEqual([
      "query:extensions",
      "query:operationName",
      "query:query",
      "query:variables",
    ]);
    expect(LINEAR_ROUTES.graphqlPost.inputs.map((input) => `${input.location}:${input.name}`)).toEqual([
      "body:extensions",
      "body:operationName",
      "body:query",
      "body:variables",
    ]);
  });
});

// ─── F-1385 — `extensions`, the fourth envelope member ───────────────────────
//
// Re-measured against real `https://api.linear.app/graphql` on 2026-08-11. The
// ticket's reading — that Linear's 400 is "automatic persisted queries simply
// switched off" — is FALSIFIED by that measurement: Linear runs APQ in
// verify-only mode, and the 400 is the hash check failing. The full transcript
// is in `docs/undeclared-route-inputs.md`; this suite is the same table driven
// over the real HTTP wire, which is the third of F-1385's Done-whens.
//
// Every case below is answered BEFORE authentication, which is why each one is
// also run with a deliberately-bad bearer token further down. That ordering is
// the fix, not a detail: reject after the auth check and an agent sending an
// APQ payload with a stale token sees 401 here and 400 at Linear — the same
// divergence in a harder-to-see form.

/** A query, and the hash an Apollo client computes for it. */
const APQ_QUERY = "{__typename}";
const APQ_HASH = createHash("sha256").update(APQ_QUERY).digest("hex");
const WRONG_HASH = "abc";

/** A token that is syntactically a bearer and resolves to no session. */
const BAD_TOKEN = "lin_api_deliberately_not_a_real_token";

function persistedQuery(descriptor: unknown): Record<string, unknown> {
  return { persistedQuery: descriptor };
}

/** Linear's answer to an APQ descriptor it cannot satisfy. */
const INTERNAL_SERVER_ERROR = {
  errors: [
    {
      message: "Internal server error",
      extensions: {
        http: { status: 400, headers: {} },
        code: "INTERNAL_SERVER_ERROR",
        type: "internal error",
        userError: false,
      },
    },
  ],
};

/** Linear's answer to an `extensions` value that is not a usable object. */
function badRequest(message: string) {
  return {
    errors: [
      {
        message,
        extensions: {
          http: { status: 400, headers: {} },
          code: "BAD_REQUEST",
          type: "internal error",
          userError: false,
        },
      },
    ],
  };
}

/** APQ's lookup miss — HTTP 200, the error inside the envelope. */
const PERSISTED_QUERY_NOT_FOUND = {
  errors: [
    {
      message: "PersistedQueryNotFound",
      extensions: {
        http: { status: 200, headers: {} },
        code: "PERSISTED_QUERY_NOT_FOUND",
        type: "graphql error",
        userError: true,
      },
    },
  ],
};

async function post(
  envelope: Record<string, unknown>,
  token: string = jwt
): Promise<{ status: number; body: unknown }> {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return { status: response.status, body: await response.json() };
}

async function get(
  params: Record<string, string>,
  token: string = jwt
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(`/graphql?${new URLSearchParams(params).toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

describe("`extensions` — the persisted-query envelope member (F-1385)", () => {
  it("declares it on both `/graphql` surfaces, so the declared lane can compare it", () => {
    // The C case of the measurement is why this is DECLARED rather than left to
    // the twin's `ignore` disposition: an unknown envelope key (`bogusKey`)
    // answers exactly as the bare request does, while `extensions` has its own
    // observable contract. Only the second kind belongs in `route-inputs.ts`.
    for (const declaration of [LINEAR_ROUTES.graphqlGet, LINEAR_ROUTES.graphqlPost]) {
      expect(declaration.names, `${declaration.surface} does not declare 'extensions'`).toContain(
        "extensions"
      );
      const declared = declaration.inputs.find((input) => input.name === "extensions");
      expect(declared?.required, `${declaration.surface} makes 'extensions' required`).toBe(false);
    }
  });

  it("serves the request when `extensions` carries no persisted query", async () => {
    // Measured: `{}`, `{foo:1}`, `null` and `persistedQuery: null` each left
    // Linear's answer exactly where the bare request's was. `extensions` is not
    // a key Linear rejects; `persistedQuery` is the key it acts on.
    for (const extensions of [undefined, null, {}, { foo: 1 }, persistedQuery(null)]) {
      const { status, body } = await post({ query: APQ_QUERY, extensions });
      expect(status, `extensions ${JSON.stringify(extensions)} was not served`).toBe(200);
      expect((body as { errors?: unknown }).errors).toBeUndefined();
    }
  });

  it("serves the request when the persisted-query hash matches the query", async () => {
    // The case the ticket's ruling would have got wrong. An Apollo client with
    // APQ enabled retries a cache miss with the query AND its hash; Linear
    // verifies the pair and goes on to serve it. Answering 400 here would
    // score an agent for a failure it did not commit.
    const { status, body } = await post({
      query: APQ_QUERY,
      extensions: persistedQuery({ version: 1, sha256Hash: APQ_HASH }),
    });
    expect(status).toBe(200);
    expect((body as { errors?: unknown }).errors).toBeUndefined();
  });

  it("answers 400 `INTERNAL_SERVER_ERROR` for a descriptor it cannot satisfy", async () => {
    // Each of these was measured returning this exact envelope. The shape reads
    // like an unhandled path rather than a designed contract — `userError:
    // false` on what is plainly a client mistake — which is why it is recorded
    // as an OBSERVED behaviour in FIDELITY.md rather than asserted as intent.
    const unsatisfiable: Array<[string, unknown]> = [
      ["hash does not match the query", persistedQuery({ version: 1, sha256Hash: WRONG_HASH })],
      ["hash matches but in the wrong case", persistedQuery({ version: 1, sha256Hash: APQ_HASH.toUpperCase() })],
      ["unsupported protocol version", persistedQuery({ version: 2, sha256Hash: APQ_HASH })],
      ["no version", persistedQuery({ sha256Hash: APQ_HASH })],
      ["no hash", persistedQuery({ version: 1 })],
      ["descriptor is not an object", persistedQuery("str")],
      ["descriptor is a number", persistedQuery(7)],
      ["descriptor is empty", persistedQuery({})],
    ];
    for (const [why, extensions] of unsatisfiable) {
      const { status, body } = await post({ query: APQ_QUERY, extensions });
      expect(status, `${why}: wrong status`).toBe(400);
      expect(body, `${why}: wrong envelope`).toEqual(INTERNAL_SERVER_ERROR);
    }
  });

  it("answers 200 `PersistedQueryNotFound` when the hash arrives without a query", async () => {
    // APQ's lookup miss, and the reason modelling this needs no store: Linear
    // never registers the pair either. Sending the query WITH its correct hash
    // (the test above) does not make a later hash-only request resolve.
    const { status, body } = await post({
      extensions: persistedQuery({ version: 1, sha256Hash: APQ_HASH }),
    });
    expect(status).toBe(200);
    expect(body).toEqual(PERSISTED_QUERY_NOT_FOUND);
  });

  it("answers 400 `BAD_REQUEST` for an `extensions` that is not an object", async () => {
    for (const extensions of [42, [], true]) {
      const { status, body } = await post({ query: APQ_QUERY, extensions });
      expect(status, `extensions ${JSON.stringify(extensions)}: wrong status`).toBe(400);
      expect(body).toEqual(badRequest("`extensions` in a POST body must be an object if provided."));
    }
  });

  it("names the recursively-JSON-encoded string separately, as Linear does", async () => {
    // A distinct message from the one above: the client double-encoded, which
    // is a different mistake from sending a number, and Linear says so.
    const { status, body } = await post({
      query: APQ_QUERY,
      extensions: JSON.stringify(persistedQuery({ version: 1, sha256Hash: APQ_HASH })),
    });
    expect(status).toBe(400);
    expect(body).toEqual(
      badRequest(
        "`extensions` in a POST body should be provided as an object, not a recursively JSON-encoded string."
      )
    );
  });

  it("applies the same rules to the GET surface, where `extensions` is JSON in the query string", async () => {
    const satisfied = await get({
      query: APQ_QUERY,
      extensions: JSON.stringify(persistedQuery({ version: 1, sha256Hash: APQ_HASH })),
    });
    expect(satisfied.status).toBe(200);
    expect((satisfied.body as { errors?: unknown }).errors).toBeUndefined();

    const mismatched = await get({
      query: APQ_QUERY,
      extensions: JSON.stringify(persistedQuery({ version: 1, sha256Hash: WRONG_HASH })),
    });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body).toEqual(INTERNAL_SERVER_ERROR);

    const miss = await get({
      extensions: JSON.stringify(persistedQuery({ version: 1, sha256Hash: APQ_HASH })),
    });
    expect(miss.status).toBe(200);
    expect(miss.body).toEqual(PERSISTED_QUERY_NOT_FOUND);
  });

  it("names undecodable JSON in the query string as its own failure", async () => {
    const { status, body } = await get({ query: APQ_QUERY, extensions: "not-json" });
    expect(status).toBe(400);
    expect(body).toEqual(badRequest("The extensions search parameter contains invalid JSON."));
  });

  it("refuses query-string JSON that decodes to something other than an object", async () => {
    // The measured asymmetry between the two surfaces, and the reason the
    // decode is not shared between them: `null` is IGNORED as a POST body's
    // `extensions` and REFUSED as a query string's. Deriving one surface's
    // behaviour from the other would have got this backwards.
    for (const encoded of ["42", "[]", "null", '"str"']) {
      const { status, body } = await get({ query: APQ_QUERY, extensions: encoded });
      expect(status, `extensions=${encoded}: wrong status`).toBe(400);
      expect(body, `extensions=${encoded}: wrong envelope`).toEqual(
        badRequest("The extensions search parameter should contain a JSON-encoded object.")
      );
    }
  });

  it("answers every one of them BEFORE the authentication check", async () => {
    // The ordering pin, with a deliberately-bad token. Without it the next
    // refactor can quietly move the rejection behind `bearerAuth` and every
    // assertion above still passes — they all carry a good token.
    //
    // The control is the point of comparison: the SAME bad token, the same
    // query, no `extensions`, answers 401. So a difference here is the envelope
    // member being read ahead of the credential, not the credential being
    // accepted.
    const control = await post({ query: APQ_QUERY }, BAD_TOKEN);
    expect(control.status, "the bad token was accepted — this test proves nothing").toBe(401);

    const mismatched = await post(
      { query: APQ_QUERY, extensions: persistedQuery({ version: 1, sha256Hash: WRONG_HASH }) },
      BAD_TOKEN
    );
    expect(mismatched.status).toBe(400);
    expect(mismatched.body).toEqual(INTERNAL_SERVER_ERROR);

    const miss = await post(
      { extensions: persistedQuery({ version: 1, sha256Hash: APQ_HASH }) },
      BAD_TOKEN
    );
    expect(miss.status).toBe(200);
    expect(miss.body).toEqual(PERSISTED_QUERY_NOT_FOUND);

    const encoded = await post({ query: APQ_QUERY, extensions: 42 }, BAD_TOKEN);
    expect(encoded.status).toBe(400);
    expect(encoded.body).toEqual(
      badRequest("`extensions` in a POST body must be an object if provided.")
    );

    // And the other half of the ordering claim, which a "reject `extensions`
    // outright" fix would fail: a descriptor Linear IS satisfied by falls
    // through to the auth check and answers 401, exactly like the control.
    const satisfied = await post(
      { query: APQ_QUERY, extensions: persistedQuery({ version: 1, sha256Hash: APQ_HASH }) },
      BAD_TOKEN
    );
    expect(satisfied.status).toBe(401);
    expect(satisfied.body).toEqual(control.body);
  });

  it("hands anything it cannot parse to the ordinary recorded path", async () => {
    // The gate runs outside the recorder and outside the twin's error
    // envelope, so it must never be the thing that answers a malformed
    // request: a body that is not JSON at all is the declaration's business,
    // and it still reaches the handler that reports it.
    const response = await app.request("/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: "}{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: [{ message: "GraphQL query is required" }],
    });
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
