// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — the declaration mechanism itself. The per-twin suites drive real
// routes; this one pins the properties every one of them relies on.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MalformedBodyError,
  UndeclaredInputError,
  booleanInput,
  bracketedQuery,
  buildRouteInputArtifact,
  declareRouteInputs,
  diffRegisteredRoutes,
  integerInput,
  jsonSchemaTypeOf,
  repeatedInput,
  routeInputDeclarer,
  type RouteRequestSource,
} from "../src/route-inputs.js";

/** A `RouteRequestSource` with no hono behind it — the interface is the seam. */
function request(init: {
  url?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, unknown>;
  bytes?: Buffer;
}): RouteRequestSource {
  return {
    url: init.url ?? "http://twin.invalid/x",
    param: (name) => init.params?.[name],
    header: (name) => init.headers?.[name.toLowerCase()] ?? init.headers?.[name],
    json: async () => {
      if (init.json === undefined) throw new SyntaxError("no json");
      return init.json;
    },
    arrayBuffer: async () => {
      const bytes = init.bytes ?? Buffer.alloc(0);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    parseBody: async () => {
      if (!init.form) throw new Error("no form");
      return init.form;
    },
  };
}

describe("declareRouteInputs — the declaration is derived, never written", () => {
  it("derives name, location, required and type from the schemas that validate", () => {
    const declaration = declareRouteInputs({
      method: "POST",
      path: "/repos/:owner/:repo/issues",
      pathParams: { owner: z.string().min(1), repo: z.string().min(1) },
      query: { per_page: integerInput({ min: 1, max: 100 }).optional() },
      headers: { "Idempotency-Key": z.string().optional() },
      body: { title: z.string().min(1), labels: z.array(z.string()).optional() },
    });

    expect(declaration.surface).toBe("POST /repos/:owner/:repo/issues");
    expect(declaration.inputs).toEqual([
      { name: "owner", location: "path", required: true, type: "string" },
      { name: "repo", location: "path", required: true, type: "string" },
      { name: "per_page", location: "query", required: false, type: "integer" },
      { name: "Idempotency-Key", location: "header", required: false, type: "string" },
      { name: "labels", location: "body", required: false, type: "array" },
      { name: "title", location: "body", required: true, type: "string" },
    ]);
  });

  it("reports requiredness by asking the validator, so it cannot disagree with it", async () => {
    const declaration = declareRouteInputs({
      method: "POST",
      path: "/x",
      body: { needed: z.string(), defaulted: z.string().default("d"), nullish: z.string().nullish() },
    });
    const required = declaration.inputs.filter((input) => input.required).map((input) => input.name);
    expect(required).toEqual(["needed"]);

    // The claim above is the parser's behaviour, not a second opinion on it.
    await expect(declaration.parse(request({ json: { needed: "x" } }))).resolves.toMatchObject({
      body: { needed: "x", defaulted: "d" },
    });
    await expect(declaration.parse(request({ json: {} }))).rejects.toBeInstanceOf(z.ZodError);
  });

  it("derives `integer` for a coerced int and a joined union for a boolean-ish", () => {
    expect(jsonSchemaTypeOf(integerInput())).toBe("integer");
    expect(jsonSchemaTypeOf(booleanInput)).toBe("boolean|string");
    expect(jsonSchemaTypeOf(repeatedInput())).toBe("array");
    expect(jsonSchemaTypeOf(z.record(z.string(), z.string()))).toBe("object");
    // `.nullish()` is not a type a vendor declares; it never decides the answer.
    expect(jsonSchemaTypeOf(z.string().nullish())).toBe("string");
    // Unrepresentable rather than guessed.
    expect(jsonSchemaTypeOf(z.instanceof(Uint8Array))).toBeNull();
  });
});

describe("parse — undeclared input, under the default disposition", () => {
  const declaration = declareRouteInputs({
    method: "GET",
    path: "/repos/:owner/:repo/issues",
    pathParams: { owner: z.string(), repo: z.string() },
    query: { state: z.enum(["open", "closed", "all"]).optional() },
  });

  it("refuses a query key the declaration does not name", async () => {
    const error = await declaration
      .parse(request({ url: "http://t/x?state=open&sort=created", params: { owner: "o", repo: "r" } }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UndeclaredInputError);
    expect((error as UndeclaredInputError).location).toBe("query");
    expect((error as UndeclaredInputError).names).toEqual(["sort"]);
    expect((error as UndeclaredInputError).first).toBe("sort");
  });

  it("refuses a top-level body key the declaration does not name", async () => {
    const write = declareRouteInputs({
      method: "POST",
      path: "/x",
      body: { title: z.string() },
    });
    const error = await write
      .parse(request({ json: { title: "t", assignee: "nobody" } }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UndeclaredInputError);
    expect((error as UndeclaredInputError).location).toBe("body");
    expect((error as UndeclaredInputError).names).toEqual(["assignee"]);
  });

  it("leaves nested body shape to the schemas — only top-level names are declared", async () => {
    // The vendor declares request-body PROPERTIES; descending further would
    // assert drift on a nesting level neither side compares.
    const write = declareRouteInputs({
      method: "POST",
      path: "/x",
      body: { output: z.object({ title: z.string().optional() }).optional() },
    });
    await expect(
      write.parse(request({ json: { output: { title: "t", summary: "s" } } }))
    ).resolves.toMatchObject({ body: { output: { title: "t" } } });
  });

  it("accepts undeclared HEADERS and hides them, because every client sends some", async () => {
    const declaration2 = declareRouteInputs({
      method: "GET",
      path: "/x",
      headers: { "Idempotency-Key": z.string().optional() },
    });
    const parsed = await declaration2.parse(
      request({ headers: { "idempotency-key": "k", "user-agent": "curl", authorization: "Bearer x" } })
    );
    expect(parsed.header).toEqual({ "Idempotency-Key": "k" });
  });

  it("reads a declared header the handler can then see, and nothing else", async () => {
    const parsed = await declaration.parse(request({ url: "http://t/x", params: { owner: "o", repo: "r" } }));
    expect(parsed).toEqual({ path: { owner: "o", repo: "r" }, query: {}, header: {}, body: {} });
  });

  it("says which disposition it has, so a twin's own suite can pin the ruling", () => {
    expect(declaration.undeclared).toBe("refuse");
  });
});

// ─── F-1372 ──────────────────────────────────────────────────────────────────

describe("parse — `undeclared: 'ignore'`, the disposition a twin opts into", () => {
  // GitHub and Slack are ruled `ignore` because that is what they were measured
  // doing (`docs/undeclared-route-inputs.md`). The property that makes the
  // ruling safe to take is the one asserted throughout here: ignoring is about
  // what the CALLER is told, never about what the handler is handed. A handler
  // under `ignore` sees exactly what it sees under `refuse`.
  const lenient = routeInputDeclarer("ignore");

  const read = lenient({
    method: "GET",
    path: "/repos/:owner/:repo/issues",
    pathParams: { owner: z.string(), repo: z.string() },
    query: { state: z.enum(["open", "closed", "all"]).optional() },
  });

  it("serves a query key the declaration does not name, and the handler never sees it", async () => {
    const parsed = await read.parse(
      request({ url: "http://t/x?state=open&sort=created", params: { owner: "o", repo: "r" } })
    );
    expect(parsed.query).toEqual({ state: "open" });
    expect(Object.keys(parsed.query)).not.toContain("sort");
  });

  it("serves a top-level body key the declaration does not name, and drops it", async () => {
    const write = lenient({ method: "POST", path: "/x", body: { title: z.string() } });
    const parsed = await write.parse(request({ json: { title: "t", assignee: "nobody" } }));
    expect(parsed.body).toEqual({ title: "t" });
  });

  it("still rejects a DECLARED input whose value is wrong", async () => {
    // The disposition governs names the declaration does not have, and nothing
    // else. A twin that ignored its own schemas would answer 200 to
    // `?state=merged` and silently list everything — the bug F-1179's
    // `stateFilter` was tightened to kill.
    await expect(
      read.parse(request({ url: "http://t/x?state=merged", params: { owner: "o", repo: "r" } }))
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("still refuses undeclared input on a declaration that did not opt in", async () => {
    const strict = declareRouteInputs({ method: "GET", path: "/x", query: { a: z.string().optional() } });
    expect(strict.undeclared).toBe("refuse");
    await expect(strict.parse(request({ url: "http://t/x?b=1" }))).rejects.toBeInstanceOf(
      UndeclaredInputError
    );
  });

  it("drops a `__proto__` form key without polluting and without erroring", async () => {
    // Under `refuse` the pollution keys were dropped by `expandBrackets` and
    // then refused by the undeclared-input check, so two things stood between
    // `__proto__[polluted]=pwned` and `Object.prototype`. Under `ignore` the
    // request is SERVED, so only the first one is left — twin-slack takes form
    // bodies and is ruled `ignore`, which is that exact combination.
    const write = lenient({
      method: "POST",
      path: "/x",
      bodyEncoding: "form",
      body: { title: z.string() },
    });
    const parsed = await write.parse(
      request({ form: { "__proto__[polluted]": ["pwned"], title: ["t"] } })
    );
    expect(parsed.body).toEqual({ title: "t" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("publishes the same inputs either way, so the artifact does not move", () => {
    const strict = declareRouteInputs({
      method: "GET",
      path: "/repos/:owner/:repo/issues",
      pathParams: { owner: z.string(), repo: z.string() },
      query: { state: z.enum(["open", "closed", "all"]).optional() },
    });
    // `inputs` is derived from the declared schemas alone. A twin that flips its
    // disposition therefore publishes a byte-identical `route-inputs.json`, and
    // pome-cloud's declared-fidelity lane reports exactly the same gaps against
    // the vendor before and after — which is why the case for `ignore` had to
    // rest on fidelity rather than on anything the lane would notice.
    expect(read.inputs).toEqual(strict.inputs);
    expect(read.names).toEqual(strict.names);
    expect(read.undeclared).toBe("ignore");
  });
});

describe("parse — locations", () => {
  it("reads a wildcard tail off the pathname, decoded, under a session mount", async () => {
    const declaration = declareRouteInputs({
      method: "GET",
      path: "/repos/:owner/:repo/contents/*",
      pathParams: { owner: z.string(), repo: z.string(), path: z.string().min(1) },
    });
    expect(declaration.inputs.map((input) => input.name).sort()).toEqual(["owner", "path", "repo"]);
    const parsed = await declaration.parse(
      request({
        url: "http://t/s/abc123/repos/o/r/contents/src%2Fapp%20one.ts",
        params: { owner: "o", repo: "r" },
      })
    );
    expect(parsed.path).toEqual({ owner: "o", repo: "r", path: "src/app one.ts" });
  });

  it("reads repeated query params as a list and an absent one as empty", async () => {
    const declaration = declareRouteInputs({
      method: "GET",
      path: "/m",
      query: { labelIds: repeatedInput({ max: 10 }), q: z.string().optional() },
    });
    expect(
      (await declaration.parse(request({ url: "http://t/m?labelIds=A&labelIds=B" }))).query
    ).toEqual({ labelIds: ["A", "B"] });
    expect((await declaration.parse(request({ url: "http://t/m" }))).query).toEqual({ labelIds: [] });
  });

  it("accepts a bracketed query family under its single declared name", async () => {
    const declaration = declareRouteInputs({
      method: "GET",
      path: "/v1/charges",
      query: { created: bracketedQuery(z.union([z.string(), z.record(z.string(), z.string())]).optional()) },
    });
    expect(declaration.inputs).toEqual([
      { name: "created", location: "query", required: false, type: "object|string" },
    ]);
    expect((await declaration.parse(request({ url: "http://t/c?created=17" }))).query).toEqual({
      created: "17",
    });
    expect(
      (await declaration.parse(request({ url: "http://t/c?created[gte]=1&created[lt]=9" }))).query
    ).toEqual({ created: { gte: "1", lt: "9" } });
    // A bracketed name does not open the door to every bracketed key.
    await expect(
      declaration.parse(request({ url: "http://t/c?amount[gte]=1" }))
    ).rejects.toBeInstanceOf(UndeclaredInputError);
  });

  it("expands Stripe's bracket form encoding into nested body inputs", async () => {
    const declaration = declareRouteInputs({
      method: "POST",
      path: "/v1/payment_intents",
      bodyEncoding: "form",
      body: {
        amount: integerInput(),
        payment_method_types: z.array(z.string()).min(1),
        metadata: z.record(z.string(), z.string()).optional(),
      },
    });
    const parsed = await declaration.parse(
      request({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        form: {
          amount: ["7500"],
          "payment_method_types[0]": ["card"],
          "metadata[order]": ["o_1"],
        },
      })
    );
    expect(parsed.body).toEqual({
      amount: 7500,
      payment_method_types: ["card"],
      metadata: { order: "o_1" },
    });
  });

  it("drops prototype-walking form keys, which the undeclared check then refuses", async () => {
    const declaration = declareRouteInputs({
      method: "POST",
      path: "/v1/x",
      bodyEncoding: "form",
      body: { amount: integerInput() },
    });
    const parsed = await declaration.parse(
      request({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        form: { amount: ["1"], "__proto__[polluted]": ["yes"] },
      })
    );
    expect(parsed.body).toEqual({ amount: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("lands multipart/related media on the declared mediaField", async () => {
    const declaration = declareRouteInputs({
      method: "POST",
      path: "/upload/messages",
      bodyEncoding: "media",
      mediaField: "raw",
      body: {
        raw: z.union([z.string(), z.instanceof(Uint8Array)]),
        threadId: z.string().optional(),
      },
    });
    const boundary = "bnd";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n{"threadId":"t1"}\r\n` +
        `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\nSubject: hi\r\n\r\nbody\r\n` +
        `--${boundary}--`
    );
    const parsed = await declaration.parse(
      request({ headers: { "content-type": `multipart/related; boundary=${boundary}` }, bytes: payload })
    );
    expect(parsed.body.threadId).toBe("t1");
    expect(Buffer.from(parsed.body.raw as Uint8Array).toString()).toContain("Subject: hi");
  });

  it("lands a bare MIME body on the declared mediaField too", async () => {
    const declaration = declareRouteInputs({
      method: "POST",
      path: "/upload/messages",
      bodyEncoding: "media",
      mediaField: "message.raw",
      body: { message: z.object({ raw: z.instanceof(Uint8Array) }) },
    });
    const parsed = await declaration.parse(
      request({ headers: { "content-type": "message/rfc822" }, bytes: Buffer.from("Subject: x") })
    );
    expect(Buffer.from((parsed.body.message as { raw: Uint8Array }).raw).toString()).toBe("Subject: x");
  });

  it("distinguishes a body that must parse from one that may be empty", async () => {
    const strict = declareRouteInputs({ method: "POST", path: "/a", bodyEncoding: "json", body: {} });
    const lenient = declareRouteInputs({ method: "PUT", path: "/b", bodyEncoding: "json-optional", body: {} });
    await expect(strict.parse(request({}))).rejects.toBeInstanceOf(MalformedBodyError);
    await expect(lenient.parse(request({}))).resolves.toMatchObject({ body: {} });
  });
});

describe("declaration-time errors — a declaration that has already drifted cannot be built", () => {
  it("refuses a pattern param with no declared schema", () => {
    expect(() =>
      declareRouteInputs({ method: "GET", path: "/repos/:owner/:repo", pathParams: { owner: z.string() } })
    ).toThrow(/does not declare path param 'repo'/);
  });

  it("refuses a declared path param the pattern does not contain", () => {
    expect(() =>
      declareRouteInputs({ method: "GET", path: "/repos/:owner", pathParams: { owner: z.string(), ghost: z.string() } })
    ).toThrow(/declares path param 'ghost' its pattern does not contain/);
  });

  it("requires exactly one declared name for a wildcard segment", () => {
    expect(() =>
      declareRouteInputs({ method: "GET", path: "/repos/:owner/contents/*", pathParams: { owner: z.string() } })
    ).toThrow(/exactly one declared path param must name it/);
  });

  it("ALLOWS one name in two locations, because the vendors do", async () => {
    // Gmail's `drafts.update` takes the draft id in the path and a Draft
    // resource body that carries `id`; GitHub echoes a path id in PATCH bodies
    // the same way. Both accept the echo. Throwing here — which an earlier draft
    // of this module did — turned accept-and-discard into a 400: a divergence
    // manufactured by our own type rule, in the direction that fails an agent
    // written correctly against the real vendor.
    const declaration = declareRouteInputs({
      method: "PUT",
      path: "/drafts/:id",
      pathParams: { id: z.string().min(1) },
      body: { id: z.string().optional(), raw: z.string() },
    });
    expect(declaration.inputs).toEqual([
      { name: "id", location: "path", required: true, type: "string" },
      { name: "id", location: "body", required: false, type: "string" },
      { name: "raw", location: "body", required: true, type: "string" },
    ]);
    // One name to pome-cloud's comparator, which diffs NAME sets.
    expect(declaration.names).toEqual(["id", "raw"]);

    const parsed = await declaration.parse(
      request({ params: { id: "d_1" }, json: { id: "d_1", raw: "bXNn" } })
    );
    expect(parsed.path.id).toBe("d_1");
    expect(parsed.body.id).toBe("d_1");
  });

  it("refuses body inputs with no body encoding, and media with no field", () => {
    expect(() =>
      declareRouteInputs({ method: "POST", path: "/x", bodyEncoding: "none", body: { a: z.string() } })
    ).toThrow(/bodyEncoding 'none'/);
    expect(() => declareRouteInputs({ method: "POST", path: "/x", bodyEncoding: "media" })).toThrow(
      /without mediaField/
    );
  });
});

describe("published artifact", () => {
  const declarations = [
    declareRouteInputs({
      method: "GET",
      path: "/user",
    }),
    declareRouteInputs({
      method: "GET",
      path: "/repos/:owner/:repo",
      pathParams: { owner: z.string(), repo: z.string() },
    }),
  ];

  it("omits zero-input surfaces rather than publishing an empty declaration", () => {
    // pome-cloud counts an empty declaration as `empty-declaration`, a
    // non-result, so that comparing nothing against nothing never renders as a
    // pass. Emitting `[]` would ask it to.
    const artifact = buildRouteInputArtifact({
      twin: "github",
      package: "@pome-sh/twin-github",
      generatedBy: "npm run emit:route-inputs",
      source: ["packages/twin-github/src/route-inputs.ts"],
      declarations,
    });
    expect(artifact.surfaces.map((surface) => surface.surface)).toEqual(["GET /repos/:owner/:repo"]);
    expect(artifact.surface_count).toBe(1);
    expect(artifact.input_count).toBe(2);
  });

  it("sorts surfaces so a reordered source file produces a byte-identical artifact", () => {
    const forward = buildRouteInputArtifact({
      twin: "t",
      package: "p",
      generatedBy: "g",
      source: ["s"],
      declarations,
    });
    const reversed = buildRouteInputArtifact({
      twin: "t",
      package: "p",
      generatedBy: "g",
      source: ["s"],
      declarations: [...declarations].reverse(),
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

describe("diffRegisteredRoutes", () => {
  const declared = [
    declareRouteInputs({ method: "GET", path: "/a" }),
    declareRouteInputs({ method: "POST", path: "/b" }),
  ];

  it("is clean when every route is declared and every declaration is mounted", () => {
    expect(diffRegisteredRoutes(["GET /a", "POST /b"], declared)).toEqual({
      undeclared: [],
      unmounted: [],
      duplicated: [],
    });
  });

  it("names a route registered without a declaration and a declaration nothing mounts", () => {
    expect(diffRegisteredRoutes(["GET /a", "GET /c"], declared)).toEqual({
      undeclared: ["GET /c"],
      unmounted: ["POST /b"],
      duplicated: [],
    });
  });

  it("names a declaration mounted twice, which would publish one surface for two handlers", () => {
    const twice = [...declared, declareRouteInputs({ method: "GET", path: "/a" })];
    expect(diffRegisteredRoutes(["GET /a", "POST /b"], twice).duplicated).toEqual(["GET /a"]);
  });
});
