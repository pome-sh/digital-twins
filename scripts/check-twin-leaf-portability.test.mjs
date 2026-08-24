#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-twin-leaf-portability.mjs`.
//
// The gate exists because a green twins CI shipped a change that could not be
// LOADED by the runtime pome-cloud reads those files with, so the thing most
// worth proving is that it goes red on the exact shape that shipped: a tool
// table importing the `@pome-sh/sdk` ROOT for the fixture loader, when
// the root barrel re-exports the `node:sqlite`-backed database module.
//
// The rest of the cases guard the ways a gate like this quietly stops working:
// the leaf subpath is not recognised as clean (false red, and the gate gets
// deleted); a type-only import counted as a runtime edge (same); the lexer
// swallowing a real import that sits below a statement (false GREEN, the worst
// of the three); a twin's tool table no longer found, so it is silently no
// longer walked; and a named cross-runtime leaf that no longer exists.
//
// Each case builds a throwaway tree and runs the real script against it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-twin-leaf-portability.mjs");

/** A minimal sdk: a root barrel that re-exports the `node:sqlite` driver (the
 *  real shape), plus the dependency-free fixture loader on its own subpath. */
const SDK_FILES = {
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

/**
 * A minimal twin. `toolTable` is the body of the module that calls the loader;
 * the other files exist so the twin has a domain worth NOT reaching, and the
 * five named `CROSS_RUNTIME_LEAVES` the real gate carries.
 */
function twinFiles(name, toolTable) {
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

/** The named leaves the real script insists exist. Kept trivially clean so a
 *  case only ever fails on the thing it is about. */
const LEAF_FILES = {
  "packages/twin-github/src/unsupported-envelope.ts": `export const unsupportedEnvelope = { body: {} };\n`,
  "packages/twin-slack/src/unsupported-envelope.ts": `export const unsupportedEnvelope = { body: {} };\n`,
  "packages/twin-stripe/src/errors.ts": `export const unsupported = () => ({ body: {} });\n`,
  "packages/twin-linear/src/graphql/schema.ts": `export const linearGraphQLSchema = "type Query { a: Int }";\n`,
};

const CLEAN_TABLE = [
  `import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";`,
  `export const fixture = loadMcpToolFixture({});`,
].join("\n");

/**
 * `CROSS_RUNTIME_LEAVES` names `packages/twin-stripe/src/tools.ts` and every
 * twin needs a tool table, so a tree always carries the five real twin dirs.
 * `extra` overwrites any of them.
 */
function runAgainst(extra = {}, { bare = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "twin-leaf-portability-"));
  const files = bare ? {} : { ...SDK_FILES };
  if (!bare) {
    for (const twin of ["github", "gmail", "linear", "slack", "stripe"]) {
      Object.assign(files, twinFiles(twin, CLEAN_TABLE));
    }
    Object.assign(files, LEAF_FILES);
  }
  Object.assign(files, extra);
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue; // an explicit "this file does not exist"
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

let failures = 0;
function check(name, { files, expect, contains, bare }) {
  const { code, out } = runAgainst(files, { bare });
  const got = code === 0 ? "green" : "red";
  const problems = [];
  if (got !== expect) problems.push(`expected ${expect}, got ${got}`);
  if (contains && !out.includes(contains)) problems.push(`output missing ${JSON.stringify(contains)}`);
  if (problems.length > 0) {
    failures += 1;
    console.error(`✗ ${name}\n  ${problems.join("\n  ")}\n${out.replace(/^/gm, "    ")}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

check("1. the fixed shape is green: every tool table on the `/mcp-tool-fixture` leaf", {
  files: {},
  expect: "green",
});

check("2. a tool table importing the sdk ROOT is red (the shape that shipped)", {
  files: {
    "packages/twin-stripe/src/tools.ts": [
      `import { loadMcpToolFixture } from "@pome-sh/sdk";`,
      `export const fixture = loadMcpToolFixture({});`,
    ].join("\n"),
  },
  expect: "red",
  contains: "node:sqlite",
});

check("3. the failure names the module and prints the chain to the builtin", {
  files: {
    "packages/twin-slack/src/tools.ts": [
      `import { loadMcpToolFixture } from "@pome-sh/sdk";`,
      `export const fixture = loadMcpToolFixture({});`,
    ].join("\n"),
  },
  expect: "red",
  contains: "packages/sdk/src/db.ts",
});

check("4. an INDIRECT edge through the twin's own domain is red", {
  files: {
    "packages/twin-github/src/tools.ts": [
      CLEAN_TABLE,
      `import { domain } from "./domain/index.js";`,
      `export const d = domain;`,
    ].join("\n"),
  },
  expect: "red",
  contains: "twin-github/src/domain/index.ts",
});

check("5. a type-only import of the sdk root is not a runtime edge", {
  files: {
    "packages/twin-gmail/src/tools.ts": [
      CLEAN_TABLE,
      `import type { openTwinDatabase } from "@pome-sh/sdk";`,
      `import { type openTwinDatabase as O2 } from "@pome-sh/sdk";`,
      `export type A = typeof openTwinDatabase;`,
      `export type B = typeof O2;`,
    ].join("\n"),
  },
  expect: "green",
});

check("6. an import BELOW a statement is still seen (a lexer that swallowed it would go false-green)", {
  files: {
    "packages/twin-slack/src/tools.ts": [
      CLEAN_TABLE,
      `export const marker = { name: "x" };`,
      `import { openTwinDatabase } from "@pome-sh/sdk";`,
      `export const d = openTwinDatabase;`,
    ].join("\n"),
  },
  expect: "red",
  contains: "node:sqlite",
});

check("7. a named cross-runtime leaf that reaches the builtin is red, tool table or not", {
  files: {
    "packages/twin-linear/src/graphql/schema.ts": [
      `import { openTwinDatabase } from "@pome-sh/sdk";`,
      `export const linearGraphQLSchema = String(openTwinDatabase);`,
    ].join("\n"),
  },
  expect: "red",
  contains: "twin-linear/src/graphql/schema.ts",
});

check("8. a twin whose tool table stopped calling the loader is red, not silently unwalked", {
  files: {
    "packages/twin-gmail/src/tools.ts": `export const toolDefinitions = [{ name: "hand_written" }];\n`,
  },
  expect: "red",
  contains: "packages/twin-gmail",
});

check("9. a named cross-runtime leaf that no longer exists is red, not skipped", {
  files: { "packages/twin-stripe/src/errors.ts": null },
  expect: "red",
  contains: "covers nothing",
});

check("10. an empty tree is red — a gate with nothing to walk is not coverage", {
  files: { "package.json": JSON.stringify({ name: "root" }) },
  bare: true,
  expect: "red",
  contains: "Run this from the repo root",
});

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log(`\ncheck-twin-leaf-portability.test: 10 cases passed.`);
