#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The rule's whole job is to stop one line from silently un-publishing part of a
// twin's input surface, so what is worth proving is the set of ways it could stop
// noticing:
//
//   * a read in the route module itself (the obvious case);
//   * a read in a HELPER the route module imports — the case that matters most,
//     because that is where gmail's input names actually lived, two modules from
//     anything named "routes";
//   * a twin whose registrar the rule can no longer find, which is the cheap way
//     to pass a reachability rule: it must be a hard failure, not a skip;
//   * a registrar recognised only by its ROUTER PARAMETER, since every twin
//     registers some routes through a path variable and an earlier draft that
//     looked for a literal path missed gmail and slack entirely;
//   * a read that is only mentioned in a comment or a template literal, which
//     must NOT red the rule — a false positive is how a rule gets deleted;
//   * a module in another twin, so a violation is reported against the twin that
//     owns it rather than whichever registrar reached it first;
//   * an exemption that grants ONE EXPRESSION not letting a NEW read of the same
//     kind through on a new line in the same module;
//   * an exemption that no longer matches anything going RED rather than quietly
//     passing, because an allowlist that has stopped matching is a rule
//     measuring less than it claims;
//   * a `/*` inside an ordinary string literal not blinding the lexer to the rest
//     of the module — the false-GREEN fixed in
//     `scripts/lib/static-import-graph.mjs`.

import { defineCases } from "../harness.mjs";

/**
 * The rule's real exemption list names five twin-stripe modules and one
 * twin-slack module, and requires each to exist AND still contain every exact
 * expression it grants. A throwaway tree has to carry all of them, or every case
 * fails on a stale exemption instead of on its own subject.
 */
const EXEMPT_FIXTURES = {
  "packages/twin-stripe/src/routes/_helpers.ts": [
    `export const handle = async (c) => {`,
    `  const requestBody = await c.req.raw.clone().text();`,
    `  const stepId = c.req.header("x-pome-scenario-step-id") ?? null;`,
    `  return { requestBody, stepId };`,
    `};`,
    `export const respond = (c) => ({`,
    `  correlation_id: c.req.header("x-pome-correlation-id") ?? "r",`,
    `  path: new URL(c.req.url).pathname,`,
    `});`,
  ].join("\n"),
  "packages/twin-stripe/src/idempotency.ts": [
    `export const mw = async (c) => {`,
    `  const sid = c.req.param("sid");`,
    `  const key = c.req.header("Idempotency-Key");`,
    `  const path = new URL(c.req.url).pathname;`,
    `  const stepId = c.req.header("x-pome-scenario-step-id") ?? null;`,
    `  return { sid, key, path, stepId,`,
    `    correlation_id: c.req.header("x-pome-correlation-id") ?? "r",`,
    `    path: new URL(c.req.url).pathname };`,
    `};`,
  ].join("\n"),
  "packages/twin-stripe/src/x402.ts": [
    `export const x402 = (c) => {`,
    `  const url = new URL(c.req.url);`,
    `  return c.req.header("X-PAYMENT") ?? url.pathname;`,
    `};`,
  ].join("\n"),
  "packages/twin-stripe/src/session.ts": [
    `import { x402 } from "./x402.js";`,
    `import { mw } from "./idempotency.js";`,
    `export const gated = (c) => {`,
    `  x402(c);`,
    `  mw(c);`,
    `  const header = c.req.header("authorization") ?? "";`,
    `  return {`,
    `    correlation_id: c.req.header("x-pome-correlation-id") ?? "r",`,
    `    step: c.req.header("x-pome-scenario-step-id") ?? null,`,
    `    path: new URL(c.req.url).pathname,`,
    `    header };`,
    `};`,
  ].join("\n"),
  "packages/twin-stripe/src/twin.ts": [
    `import type { Hono } from "hono";`,
    `import { gated } from "./session.js";`,
    `import { handle } from "./routes/_helpers.js";`,
    `export const bodyReader = async (c) => {`,
    `  if (new URL(c.req.url).pathname.endsWith("/admin/seed")) {`,
    `    return await c.req.json();`,
    `  }`,
    `  const contentType = c.req.header("content-type") ?? "";`,
    `  if (contentType.includes("form")) {`,
    `    return await c.req.parseBody();`,
    `  }`,
    `  return await c.req.json();`,
    `};`,
    `export const mount = (app: Hono) => { handle(app); return gated(app); };`,
  ].join("\n"),
  // twin-slack reaches its bodyReader through `twin.ts`, not through routes.ts —
  // which is exactly why the rule seeds on the router parameter.
  "packages/twin-slack/src/twin.ts": [
    `import type { Hono } from "hono";`,
    `import { parseFormOrJson } from "./util.js";`,
    `export const mount = (app: Hono) => { void parseFormOrJson; return app; };`,
  ].join("\n"),
  "packages/twin-slack/package.json": JSON.stringify({
    name: "@pome-sh/twin-slack",
    exports: { ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" } },
  }),
  "packages/twin-slack/src/util.ts": [
    `export async function parseFormOrJson(c) {`,
    `  const contentType = (c.req.header("content-type") ?? "").toLowerCase();`,
    `  if (contentType.includes("application/json")) {`,
    `    const body = await c.req.json();`,
    `    return body;`,
    `  }`,
    `  const body = await c.req.parseBody();`,
    `  return body;`,
    `}`,
  ].join("\n"),
  // twin-linear's pre-auth `extensions` gate — the one exemption that grants a
  // CLONE rather than a named read, so that the recorder's own
  // `raw.clone().json()` still has an undisturbed stream to read.
  "packages/twin-linear/src/twin.ts": [
    `import type { Hono } from "hono";`,
    `import { HonoRequest } from "hono/request";`,
    `export const gate = async (c) => {`,
    `  const peek = new HonoRequest(c.req.raw.clone());`,
    `  return await ROUTES.graphqlPost.parse(peek);`,
    `};`,
    `export const mount = (app: Hono) => app;`,
  ].join("\n"),
  "packages/twin-linear/package.json": JSON.stringify({
    name: "@pome-sh/twin-linear",
    exports: { ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" } },
  }),
};

const SDK_FILES = {
  "packages/sdk/package.json": JSON.stringify({
    name: "@pome-sh/sdk",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./route-inputs": {
        types: "./dist/route-inputs.d.ts",
        default: "./dist/route-inputs.js",
      },
    },
  }),
  "packages/sdk/src/index.ts": `export const nothing = 1;\n`,
  "packages/sdk/src/route-inputs.ts": [
    `export const declareRouteInputs = (spec) => spec;`,
    `export const mountDeclaredRoute = (router, d, h) => router;`,
  ].join("\n"),
};

/** A twin whose route module is clean and declaration-driven. */
function cleanTwin(name) {
  const dir = `packages/twin-${name}/`;
  return {
    [`${dir}package.json`]: JSON.stringify({
      name: `@pome-sh/twin-${name}`,
      exports: { ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" } },
    }),
    [`${dir}src/route-inputs.ts`]: [
      `import { declareRouteInputs } from "@pome-sh/sdk/route-inputs";`,
      `export const R = { list: declareRouteInputs({ method: "GET", path: "/things" }) };`,
    ].join("\n"),
    [`${dir}src/routes.ts`]: [
      `import type { Hono } from "hono";`,
      `import { mountDeclaredRoute } from "@pome-sh/sdk/route-inputs";`,
      `import { R } from "./route-inputs.js";`,
      `import { shape } from "./helpers.js";`,
      `export function register${name}Routes(app: Hono) {`,
      `  mountDeclaredRoute(app, R.list, (c) => shape(c));`,
      `}`,
    ].join("\n"),
    [`${dir}src/helpers.ts`]: `export const shape = (c) => ({ ok: true });\n`,
  };
}
/** The baseline every other case is a mutation of: two clean twins, plus the
 *  stripe and slack modules the real exemption list names. */
const BASE = { ...SDK_FILES, ...EXEMPT_FIXTURES, ...cleanTwin("github"), ...cleanTwin("gmail") };

/** BASE with the given overrides applied; a key mapped to `undefined` is dropped,
 *  to express "this file does not exist". */
const withFiles = (overrides) =>
  Object.fromEntries(Object.entries({ ...BASE, ...overrides }).filter(([, body]) => body !== undefined));

defineCases("route-inputs", [
  {
    name: "a declaration-driven tree passes, and says how much it covered",
    files: BASE,
    expect: "green",
    // The twin count tracks EXEMPT_FIXTURES, which has to carry every twin the
    // real exemption list names — five, including twin-linear's. A pass that
    // names no count cannot be told apart from a pass over nothing.
    contains: /\d+ module\(s\) reachable from \d+ route registrar\(s\) across 5 twins/,
  },
  {
    name: "a read in the route module reds the rule, naming file, line and read",
    files: withFiles({
      "packages/twin-github/src/routes.ts": BASE["packages/twin-github/src/routes.ts"].replace(
        `  mountDeclaredRoute(app, R.list, (c) => shape(c));`,
        `  mountDeclaredRoute(app, R.list, (c) => shape(c.req.query("sort")));`,
      ),
    }),
    expect: "red",
    contains: /packages\/twin-github\/src\/routes\.ts:6\s+— req\.query\(/,
  },
  {
    // THE case that matters. A rule that only looked at files named `routes*`
    // would be green here, and gmail's entire query surface lived in exactly
    // such a helper.
    name: "a read in an imported helper reds the rule, and both reads are reported",
    files: withFiles({
      "packages/twin-gmail/src/helpers.ts":
        `export const shape = (c) => ({ q: c.req.query("q"), id: c.req.param("id") });\n`,
    }),
    expect: "red",
    contains: [
      /packages\/twin-gmail\/src\/helpers\.ts:1\s+— req\.query\(/,
      /packages\/twin-gmail\/src\/helpers\.ts:1\s+— req\.param\(/,
    ],
  },
  {
    // Deleting the thing a reachability rule walks is the cheap way to pass it.
    name: "a twin with no discoverable registrar reds the rule, naming the twin",
    files: withFiles({
      "packages/twin-gmail/src/routes.ts": [
        `import { mount } from "./helpers.js";`,
        `export const register = (app) => mount(app);`,
      ].join("\n"),
      "packages/twin-gmail/src/helpers.ts": `export const mount = (app) => app;\n`,
    }),
    expect: "red",
    contains: ["packages/twin-gmail", "covers nothing for them"],
  },
  {
    // gmail's and slack's real shape. The draft that looked for a literal path
    // found neither.
    name: "a registrar found by its router parameter is still checked",
    files: withFiles({
      "packages/twin-gmail/src/routes.ts": [
        `import type { Hono } from "hono";`,
        `const BASE = "/gmail/v1/users/:userId/messages";`,
        `export function registerGmailRoutes(app: Hono) {`,
        `  app.get(BASE, (c) => c.req.query("q"));`,
        `}`,
      ].join("\n"),
    }),
    expect: "red",
    contains: /packages\/twin-gmail\/src\/routes\.ts:4\s+— req\.query\(/,
  },
  {
    // Comments and template literals are not code. A false red here is how a
    // rule stops being trusted and then stops existing.
    name: "a read named only in a comment or template literal is not a violation",
    files: withFiles({
      "packages/twin-github/src/helpers.ts": [
        `// Historical note: this used to read c.req.query("sort") directly.`,
        `/* and c.req.param("owner") too */`,
        'export const scaffold = `const q = c.req.query("q");`;',
        `export const shape = (c) => ({ ok: true });`,
      ].join("\n"),
    }),
    expect: "green",
  },
  {
    // A violation is reported against the twin that owns the module, not
    // whichever registrar reached it. Both twins import their own helper here;
    // only gmail's is dirty, so github's identically-named module must be silent.
    name: "one dirty twin reds the rule without implicating its clean neighbour",
    files: withFiles({
      "packages/twin-gmail/src/helpers.ts": `export const shape = (c) => c.req.header("x-thing");\n`,
    }),
    expect: "red",
    contains: /twin-gmail\/src\/helpers\.ts:1\s+— req\.header\(/,
    notContains: "twin-github/src/helpers.ts",
  },
  {
    // An exemption grants ONE EXPRESSION, not a file and not a read kind: a NEW
    // read of the same kind, on a new line in the same exempt module, is still a
    // violation. This is the hole a whole-file skip would open — a real violation
    // hiding behind a legitimate neighbour. The two granted expressions on lines
    // 2 and 3 must stay unreported.
    name: "a NEW read in an exempt module, of a granted KIND, is still a violation",
    files: withFiles({
      "packages/twin-stripe/src/x402.ts": [
        `export const x402 = (c) => {`,
        `  const url = new URL(c.req.url);`,
        `  const paid = c.req.header("X-PAYMENT");`,
        `  const sort = c.req.header("x-sneaky-input");`,
        `  return [url, paid, sort];`,
        `};`,
      ].join("\n"),
    }),
    expect: "red",
    contains: /packages\/twin-stripe\/src\/x402\.ts:4\s+— req\.header\(/,
    notContains: [/x402\.ts:2\s+—/, /x402\.ts:3\s+—/],
  },
  {
    name: "an exemption granting an expression the file no longer contains reds the rule",
    files: withFiles({
      "packages/twin-stripe/src/x402.ts": `export const x402 = (c) => c.req.header("X-PAYMENT");\n`,
    }),
    expect: "red",
    contains: "grants `const url = new URL(c.req.url)`, which the file no longer contains",
  },
  {
    name: "an exemption for a module that no longer exists reds the rule",
    files: withFiles({ "packages/twin-stripe/src/session.ts": undefined }),
    expect: "red",
    contains: "packages/twin-stripe/src/session.ts — does not exist",
  },
  {
    name: "an empty tree reds the rule",
    files: SDK_FILES,
    expect: "red",
    contains: "No packages/twin-*",
  },
  {
    // The lexer regression. `stripNonCode` used to read the `/*` inside an
    // ordinary string literal as a block-comment opener and blank everything up
    // to the next `*/`. twin-stripe really does mount middleware at
    // `session.use("/x402/*", …)`, which blanked 37 lines including a header
    // read. A read below such a string must still be seen: this is the
    // false-GREEN case.
    name: "a read below a string containing `/*` is still seen (was a false green)",
    files: withFiles({
      "packages/twin-github/src/routes.ts": [
        `import type { Hono } from "hono";`,
        `import { mountDeclaredRoute } from "@pome-sh/sdk/route-inputs";`,
        `import { R } from "./route-inputs.js";`,
        `export function registerGithubRoutes(app: Hono) {`,
        `  app.use("/v1/*", passthrough);`,
        `  const description = "Stripe-shaped REST under /v1/*";`,
        `  mountDeclaredRoute(app, R.list, (c) => c.req.query("sort") ?? description);`,
        `}`,
      ].join("\n"),
    }),
    expect: "red",
    contains: /packages\/twin-github\/src\/routes\.ts:7\s+— req\.query\(/,
  },
  {
    // The same string must not swallow an entire module either: a read many lines
    // after the `/*`-bearing string is still reported.
    name: "a `/*` string does not blind the rule to the rest of the module",
    files: withFiles({
      "packages/twin-gmail/src/helpers.ts": [
        `const MOUNT = "/upload/gmail/v1/*";`,
        ``,
        `export const shape = (c) => ({ mount: MOUNT, q: c.req.query("q") });`,
      ].join("\n"),
    }),
    expect: "red",
    contains: /packages\/twin-gmail\/src\/helpers\.ts:3\s+— req\.query\(/,
  },
]);
