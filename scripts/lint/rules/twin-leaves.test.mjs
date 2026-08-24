#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Cases 5, 6 and 8–10 are the ones that matter. 5 and 6 guard the lexer (a
// type-only import counted as a runtime edge is a false red that gets the rule
// deleted; an import BELOW a statement that the lexer swallows is a false
// green). 8–10 guard the cheap ways a reachability rule stops working: the twin
// stops calling the loader, a named leaf moves, or the tree has nothing in it.

import { defineCases } from "../harness.mjs";

/** A minimal sdk: a root barrel that re-exports the `node:sqlite` driver (the
 *  real shape), plus the dependency-free fixture loader on its own subpath. */
const SDK = {
  "packages/sdk/package.json": JSON.stringify({
    name: "@pome-sh/sdk",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./db": { types: "./dist/db.d.ts", default: "./dist/db.js" },
      "./mcp-tool-fixture": {
        types: "./dist/mcp-tool-fixture.d.ts",
        default: "./dist/mcp-tool-fixture.js",
      },
    },
  }),
  "packages/sdk/src/index.ts": [
    `export { openTwinDatabase } from "./db.js";`,
    `export { loadMcpToolFixture } from "./mcp-tool-fixture.js";`,
  ].join("\n"),
  "packages/sdk/src/db.ts": [
    `import { DatabaseSync } from "node:sqlite";`,
    `export const openTwinDatabase = () => new DatabaseSync(":memory:");`,
  ].join("\n"),
  "packages/sdk/src/mcp-tool-fixture.ts": `export const loadMcpToolFixture = (input) => input;\n`,
};

const CLEAN_TABLE = [
  `import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";`,
  `export const fixture = loadMcpToolFixture({});`,
].join("\n");

/** A minimal twin. The domain module exists so the twin has something worth NOT
 *  reaching. */
function twin(name, toolTable = CLEAN_TABLE) {
  const dir = `packages/twin-${name}/`;
  return {
    [`${dir}package.json`]: JSON.stringify({
      name: `@pome-sh/twin-${name}`,
      exports: { ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" } },
    }),
    [`${dir}src/tools.ts`]: toolTable,
    [`${dir}src/domain/index.ts`]: `import { openTwinDatabase } from "@pome-sh/sdk";\nexport const domain = openTwinDatabase;\n`,
  };
}

/** The named CROSS_RUNTIME_LEAVES the rule insists exist. Kept trivially clean
 *  so a case only ever fails on the thing it is about. */
const LEAVES = {
  "packages/twin-github/src/unsupported-envelope.ts": `export const unsupportedEnvelope = { body: {} };\n`,
  "packages/twin-slack/src/unsupported-envelope.ts": `export const unsupportedEnvelope = { body: {} };\n`,
  "packages/twin-stripe/src/errors.ts": `export const unsupported = () => ({ body: {} });\n`,
  "packages/twin-linear/src/graphql/schema.ts": `export const linearGraphQLSchema = "type Query { a: Int }";\n`,
};

/** `CROSS_RUNTIME_LEAVES` names `packages/twin-stripe/src/tools.ts` and every
 *  twin needs a tool table, so a tree always carries the five real twin dirs.
 *  `overrides` replaces any of them; a key mapped to `undefined` is dropped, to
 *  express "this file does not exist". */
function tree(overrides = {}) {
  const files = { ...SDK };
  for (const name of ["github", "gmail", "linear", "slack", "stripe"]) Object.assign(files, twin(name));
  Object.assign(files, LEAVES, overrides);
  return Object.fromEntries(Object.entries(files).filter(([, body]) => body !== undefined));
}

const ROOT_IMPORT_TABLE = [
  `import { loadMcpToolFixture } from "@pome-sh/sdk";`,
  `export const fixture = loadMcpToolFixture({});`,
].join("\n");

defineCases("twin-leaves", [
  {
    name: "the fixed shape is green: every tool table on the `/mcp-tool-fixture` leaf",
    files: tree(),
    expect: "green",
  },
  {
    name: "a tool table importing the sdk ROOT is red (the shape that shipped)",
    files: tree({ "packages/twin-stripe/src/tools.ts": ROOT_IMPORT_TABLE }),
    expect: "red",
    contains: "node:sqlite",
  },
  {
    name: "the failure names the module and prints the chain to the builtin",
    files: tree({ "packages/twin-slack/src/tools.ts": ROOT_IMPORT_TABLE }),
    expect: "red",
    contains: "packages/sdk/src/db.ts",
  },
  {
    name: "an INDIRECT edge through the twin's own domain is red",
    files: tree({
      "packages/twin-github/src/tools.ts": [
        CLEAN_TABLE,
        `import { domain } from "./domain/index.js";`,
        `export const d = domain;`,
      ].join("\n"),
    }),
    expect: "red",
    contains: "twin-github/src/domain/index.ts",
  },
  {
    name: "a type-only import of the sdk root is not a runtime edge",
    files: tree({
      "packages/twin-gmail/src/tools.ts": [
        CLEAN_TABLE,
        `import type { openTwinDatabase } from "@pome-sh/sdk";`,
        `import { type openTwinDatabase as O2 } from "@pome-sh/sdk";`,
        `export type A = typeof openTwinDatabase;`,
        `export type B = typeof O2;`,
      ].join("\n"),
    }),
    expect: "green",
  },
  {
    name: "an import BELOW a statement is still seen (a lexer that swallowed it would go false-green)",
    files: tree({
      "packages/twin-slack/src/tools.ts": [
        CLEAN_TABLE,
        `export const marker = { name: "x" };`,
        `import { openTwinDatabase } from "@pome-sh/sdk";`,
        `export const d = openTwinDatabase;`,
      ].join("\n"),
    }),
    expect: "red",
    contains: "node:sqlite",
  },
  {
    name: "a named cross-runtime leaf that reaches the builtin is red, tool table or not",
    files: tree({
      "packages/twin-linear/src/graphql/schema.ts": [
        `import { openTwinDatabase } from "@pome-sh/sdk";`,
        `export const linearGraphQLSchema = String(openTwinDatabase);`,
      ].join("\n"),
    }),
    expect: "red",
    contains: "twin-linear/src/graphql/schema.ts",
  },
  {
    name: "a twin whose tool table stopped calling the loader is red, not silently unwalked",
    files: tree({
      "packages/twin-gmail/src/tools.ts": `export const toolDefinitions = [{ name: "hand_written" }];\n`,
    }),
    expect: "red",
    contains: "packages/twin-gmail",
  },
  {
    name: "a named cross-runtime leaf that no longer exists is red, not skipped",
    files: tree({ "packages/twin-stripe/src/errors.ts": undefined }),
    expect: "red",
    contains: "covers nothing",
  },
  {
    name: "an empty tree is red — a rule with nothing to walk is not coverage",
    files: { "package.json": JSON.stringify({ name: "root" }) },
    expect: "red",
    contains: "No packages/twin-*",
  },
]);
