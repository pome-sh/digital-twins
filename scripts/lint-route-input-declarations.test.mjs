#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `lint-route-input-declarations.mjs`.
//
// The gate's whole job is to stop one line from silently un-publishing part of a
// twin's input surface, so what is worth proving is the set of ways it could
// stop noticing:
//
//   * a read in the route module itself (the obvious case);
//   * a read in a HELPER the route module imports — the case that matters most,
//     because that is where gmail's input names actually lived, two modules from
//     anything named "routes";
//   * a twin whose registrar the gate can no longer find, which is the cheap way
//     to pass a reachability gate: it must be a hard failure, not a skip;
//   * a registrar recognised only by its ROUTER PARAMETER, since every twin
//     registers some routes through a path variable and an earlier draft that
//     looked for a literal path missed gmail and slack entirely;
//   * a read that is only mentioned in a comment or a template literal, which
//     must NOT red the gate — a false positive is how a gate gets deleted;
//   * a module in another twin, so a violation is reported against the twin that
//     owns it rather than whichever registrar reached it first;
//   * an exemption that grants ONE EXPRESSION not letting a NEW read of the same
//     kind through on a new line in the same module;
//   * an exemption that no longer matches anything going RED rather than quietly
//     passing, because an allowlist that has stopped matching is a gate
//     measuring less than it claims;
//   * a `/*` inside an ordinary string literal not blinding the lexer to the
//     rest of the module — the false-GREEN this ticket also fixed in
//     `scripts/lib/static-import-graph.mjs`.
//
// Each case builds a throwaway tree and runs the real script against it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "lint-route-input-declarations.mjs");

/**
 * The gate's real exemption list names five twin-stripe modules and one
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
  // which is exactly why the gate seeds on the router parameter.
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

function build(files) {
  const root = mkdtempSync(join(tmpdir(), "route-inputs-gate-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function run(files, args = []) {
  const root = build(files);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, root };
}

const problems = [];
function check(label, condition, detail = "") {
  if (condition) return;
  problems.push(`${label}${detail ? `\n    ${detail}` : ""}`);
}

/** The baseline every other case is a mutation of: two clean twins, plus the
 *  stripe and slack modules the real exemption list names. */
const BASE = { ...SDK_FILES, ...EXEMPT_FIXTURES, ...cleanTwin("github"), ...cleanTwin("gmail") };

// 1 — clean tree passes, and says how much it actually covered.
{
  const { status, output } = run(BASE);
  check("case 1: a declaration-driven tree passes", status === 0, output.trim());
  check(
    "case 1: the pass names how many modules it walked, so zero coverage is visible",
    /OK — \d+ module\(s\) reachable from \d+ route registrar\(s\) across 4 twins/.test(output),
    output.trim()
  );
}

// 2 — the obvious case: a read in the route module itself.
{
  const files = { ...BASE };
  files["packages/twin-github/src/routes.ts"] = files["packages/twin-github/src/routes.ts"].replace(
    `  mountDeclaredRoute(app, R.list, (c) => shape(c));`,
    `  mountDeclaredRoute(app, R.list, (c) => shape(c.req.query("sort")));`
  );
  const { status, output } = run(files);
  check("case 2: a read in the route module reds the gate", status === 1, output.trim());
  check(
    "case 2: the failure names the file, the line and the read",
    /packages\/twin-github\/src\/routes\.ts:6\s+— req\.query\(/.test(output),
    output.trim()
  );
}

// 3 — THE case that matters: a read in a helper the route module imports.
//     A gate that only looked at files named `routes*` would be green here, and
//     gmail's entire query surface lived in exactly such a helper.
{
  const files = { ...BASE };
  files["packages/twin-gmail/src/helpers.ts"] =
    `export const shape = (c) => ({ q: c.req.query("q"), id: c.req.param("id") });\n`;
  const { status, output } = run(files);
  check("case 3: a read in an imported helper reds the gate", status === 1, output.trim());
  check(
    "case 3: both reads in the helper are reported",
    /packages\/twin-gmail\/src\/helpers\.ts:1\s+— req\.query\(/.test(output) &&
      /packages\/twin-gmail\/src\/helpers\.ts:1\s+— req\.param\(/.test(output),
    output.trim()
  );
}

// 4 — a twin the gate can no longer find a registrar for is a FAILURE.
//     Deleting the thing a reachability gate walks is the cheap way to pass it.
{
  const files = { ...BASE };
  files["packages/twin-gmail/src/routes.ts"] = [
    `import { mount } from "./helpers.js";`,
    `export const register = (app) => mount(app);`,
  ].join("\n");
  files["packages/twin-gmail/src/helpers.ts"] = `export const mount = (app) => app;\n`;
  const { status, output } = run(files);
  check("case 4: a twin with no discoverable registrar reds the gate", status === 1, output.trim());
  check(
    "case 4: the failure names the twin whose coverage vanished",
    /packages\/twin-gmail/.test(output) && /covers nothing for them/.test(output),
    output.trim()
  );
}

// 5 — a registrar recognised ONLY by its router parameter, registering through a
//     path variable. This is gmail's and slack's real shape, and the draft that
//     looked for a literal path found neither.
{
  const files = { ...BASE };
  files["packages/twin-gmail/src/routes.ts"] = [
    `import type { Hono } from "hono";`,
    `const BASE = "/gmail/v1/users/:userId/messages";`,
    `export function registerGmailRoutes(app: Hono) {`,
    `  app.get(BASE, (c) => c.req.query("q"));`,
    `}`,
  ].join("\n");
  const { status, output } = run(files);
  check(
    "case 5: a registrar found by its router parameter is still checked",
    status === 1 && /packages\/twin-gmail\/src\/routes\.ts:4\s+— req\.query\(/.test(output),
    output.trim()
  );
}

// 6 — comments and template literals are not code. A false red here is how a
//     gate stops being trusted and then stops existing.
{
  const files = { ...BASE };
  files["packages/twin-github/src/helpers.ts"] = [
    `// Historical note: this used to read c.req.query("sort") directly.`,
    `/* and c.req.param("owner") too */`,
    'export const scaffold = `const q = c.req.query("q");`;',
    `export const shape = (c) => ({ ok: true });`,
  ].join("\n");
  const { status, output } = run(files);
  check(
    "case 6: a read named only in a comment or template literal is not a violation",
    status === 0,
    output.trim()
  );
}

// 7 — a violation is reported against the twin that owns the module, not
//     whichever registrar reached it. Both twins import their own helper here;
//     only gmail's is dirty.
{
  const files = { ...BASE };
  files["packages/twin-gmail/src/helpers.ts"] =
    `export const shape = (c) => c.req.header("x-thing");\n`;
  const { status, output } = run(files);
  check("case 7: one dirty twin reds the gate", status === 1, output.trim());
  check(
    "case 7: the clean twin's identically-named module is not reported",
    !/packages\/twin-github\/src\/helpers\.ts/.test(output),
    output.trim()
  );
}

// 8 — an exemption grants ONE EXPRESSION, not a file and not a read kind: a
//     NEW read of the same kind, on a new line in the same exempt module, is
//     still a violation. This is the hole a whole-file skip would open — a real
//     violation hiding behind a legitimate neighbour.
{
  const files = { ...BASE };
  files["packages/twin-stripe/src/x402.ts"] = [
    `export const x402 = (c) => {`,
    `  const url = new URL(c.req.url);`,
    `  const paid = c.req.header("X-PAYMENT");`,
    `  const sort = c.req.header("x-sneaky-input");`,
    `  return [url, paid, sort];`,
    `};`,
  ].join("\n");
  const { status, output } = run(files);
  check(
    "case 8: a NEW read in an exempt module, of a granted KIND, is still a violation",
    status === 1 && /packages\/twin-stripe\/src\/x402\.ts:4\s+— req\.header\(/.test(output),
    output.trim()
  );
  check(
    "case 8: the two granted expressions in the same file are not reported",
    !/x402\.ts:2\s+—/.test(output) && !/x402\.ts:3\s+—/.test(output),
    output.trim()
  );
}

// 9 — an exemption that no longer describes real code self-expires.
{
  const files = { ...BASE };
  files["packages/twin-stripe/src/x402.ts"] = `export const x402 = (c) => c.req.header("X-PAYMENT");\n`;
  const { status, output } = run(files);
  check(
    "case 9: an exemption granting an expression the file no longer contains reds the gate",
    status === 1 &&
      /grants `const url = new URL\(c\.req\.url\)`, which the file no longer contains/.test(output),
    output.trim()
  );
}

// 10 — an exempt module that has been deleted reds the gate too, rather than
//      silently covering nothing.
{
  const files = { ...BASE };
  delete files["packages/twin-stripe/src/session.ts"];
  const { status, output } = run(files);
  check(
    "case 10: an exemption for a module that no longer exists reds the gate",
    status === 1 && /packages\/twin-stripe\/src\/session\.ts — does not exist/.test(output),
    output.trim()
  );
}

// 11 — no twins at all is a failure, not a vacuous pass.
{
  const { status, output } = run({ ...SDK_FILES });
  check("case 11: an empty tree reds the gate", status === 1, output.trim());
  check(
    "case 11: the failure says the tree had no twins",
    /No packages\/twin-\* found/.test(output),
    output.trim()
  );
}

// 12 — the lexer regression this ticket also fixed. `stripNonCode` used to read
//      the `/*` inside an ordinary string literal as a block-comment opener and
//      blank everything up to the next `*/`. twin-stripe really does mount
//      middleware at `session.use("/x402/*", …)`, which blanked 37 lines
//      including a header read, and `errors.ts` (a named cross-runtime leaf for
//      the sibling portability gate) really does say `"… under /v1/*"`. A read
//      below such a string must still be seen: this is the false-GREEN case.
{
  const files = { ...BASE };
  files["packages/twin-github/src/routes.ts"] = [
    `import type { Hono } from "hono";`,
    `import { mountDeclaredRoute } from "@pome-sh/sdk/route-inputs";`,
    `import { R } from "./route-inputs.js";`,
    `export function registerGithubRoutes(app: Hono) {`,
    `  app.use("/v1/*", passthrough);`,
    `  const description = "Stripe-shaped REST under /v1/*";`,
    `  mountDeclaredRoute(app, R.list, (c) => c.req.query("sort") ?? description);`,
    `}`,
  ].join("\n");
  const { status, output } = run(files);
  check(
    "case 12: a read below a string containing `/*` is still seen (was a false green)",
    status === 1 && /packages\/twin-github\/src\/routes\.ts:7\s+— req\.query\(/.test(output),
    output.trim()
  );
}

// 13 — the same string must not swallow an entire module either: a read many
//      lines after the `/*`-bearing string is still reported.
{
  const files = { ...BASE };
  files["packages/twin-gmail/src/helpers.ts"] = [
    `const MOUNT = "/upload/gmail/v1/*";`,
    ``,
    `export const shape = (c) => ({ mount: MOUNT, q: c.req.query("q") });`,
  ].join("\n");
  const { status, output } = run(files);
  check(
    "case 13: a `/*` string does not blind the gate to the rest of the module",
    status === 1 && /packages\/twin-gmail\/src\/helpers\.ts:3\s+— req\.query\(/.test(output),
    output.trim()
  );
}

if (problems.length > 0) {
  console.error(`\nlint-route-input-declarations.test.mjs: ${problems.length} failure(s)\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("lint-route-input-declarations.test.mjs: OK — 13 cases.");
