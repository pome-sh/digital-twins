#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for route-inputs. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

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
const BASE = { ...SDK_FILES, ...EXEMPT_FIXTURES, ...cleanTwin("github"), ...cleanTwin("gmail") };

const withFiles = (overrides) =>
  Object.fromEntries(Object.entries({ ...BASE, ...overrides }).filter(([, body]) => body !== undefined));

defineCases("route-inputs", [
  {
    name: "a declaration-driven tree passes, and says how much it covered",
    files: BASE,
    expect: "green",
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
    name: "one dirty twin reds the rule without implicating its clean neighbour",
    files: withFiles({
      "packages/twin-gmail/src/helpers.ts": `export const shape = (c) => c.req.header("x-thing");\n`,
    }),
    expect: "red",
    contains: /twin-gmail\/src\/helpers\.ts:1\s+— req\.header\(/,
    notContains: "twin-github/src/helpers.ts",
  },
  {
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
