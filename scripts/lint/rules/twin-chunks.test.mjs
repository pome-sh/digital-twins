#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for twin-chunks. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

function twin(name) {
  const dir = `packages/twin-${name}/`;
  return {
    [`${dir}package.json`]: JSON.stringify({
      name: `@pome-sh/twin-${name}`,
      exports: {
        ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
        "./checks": { types: "./dist/src/checks.d.ts", default: "./dist/src/checks.js" },
        "./seed": { types: "./dist/src/seed.d.ts", default: "./dist/src/seed.js" },
      },
    }),
    [`${dir}src/index.ts`]: [
      `export { ${name}Domain } from "./domain/index.js";`,
      `export { open${name}Database } from "./db.js";`,
      `export { seedSchema } from "./seed.js";`,
    ].join("\n"),
    [`${dir}src/db.ts`]: `export function open${name}Database() { return {}; }\n`,
    [`${dir}src/domain/index.ts`]: `export class ${name}Domain {}\n`,
    [`${dir}src/seed.ts`]: `export const seedSchema = { parse: (v) => v };\n`,
    [`${dir}src/checks.ts`]: `export const CHECKS = [];\n`,
  };
}

const ALPHA = twin("alpha");
const MAIN = "cli/src/cli/main.ts";
const CHECKS_IMPORT = `import { CHECKS } from "@pome-sh/twin-alpha/checks";\nvoid CHECKS;\n`;

defineCases("twin-chunks", [
  {
    name: "the shipped shape is green: `/checks` statically, domain via import()",
    files: {
      ...ALPHA,
      [MAIN]: `${CHECKS_IMPORT}export async function boot() { return import("@pome-sh/twin-alpha"); }\n`,
    },
    expect: "green",
  },
  {
    name: "a direct package-root import is red",
    files: {
      ...ALPHA,
      [MAIN]: `${CHECKS_IMPORT}import { seedSchema } from "@pome-sh/twin-alpha";\nvoid seedSchema;\n`,
    },
    expect: "red",
    contains: "package root",
  },
  {
    name: "an INDIRECT root import two CLI modules deep is red (the original shape)",
    files: {
      ...ALPHA,
      [MAIN]: `${CHECKS_IMPORT}import { parseTask } from "../task/parseTask.js";\nvoid parseTask;\n`,
      "cli/src/task/parseTask.ts": `import { schema } from "./taskSchema.js";\nexport const parseTask = () => schema;\n`,
      "cli/src/task/taskSchema.ts": `import { seedSchema } from "@pome-sh/twin-alpha";\nexport const schema = seedSchema;\n`,
    },
    expect: "red",
    contains: "taskSchema.ts",
  },
  {
    name: "the same value read from the `/seed` leaf is green",
    files: {
      ...ALPHA,
      [MAIN]: `${CHECKS_IMPORT}import { parseTask } from "../task/parseTask.js";\nvoid parseTask;\n`,
      "cli/src/task/parseTask.ts": `import { schema } from "./taskSchema.js";\nexport const parseTask = () => schema;\n`,
      "cli/src/task/taskSchema.ts": `import { seedSchema } from "@pome-sh/twin-alpha/seed";\nexport const schema = seedSchema;\n`,
    },
    expect: "green",
  },
  {
    name: "a root import inside a SCAFFOLD template literal is not an edge",
    files: {
      ...ALPHA,
      [MAIN]:
        `${CHECKS_IMPORT}export const scaffold = \`\n` +
        `import { seedSchema } from "@pome-sh/twin-alpha";\n` +
        `console.log(seedSchema);\n\`;\n`,
    },
    expect: "green",
  },
  {
    name: "a type-only root import is not a runtime edge",
    files: {
      ...ALPHA,
      [MAIN]:
        `${CHECKS_IMPORT}import type { seedSchema } from "@pome-sh/twin-alpha";\n` +
        `import { type seedSchema as S2 } from "@pome-sh/twin-alpha";\n` +
        `export type A = typeof seedSchema;\nexport type B = typeof S2;\n`,
    },
    expect: "green",
  },
  {
    name: "dropping a twin's checks from the static graph is red",
    files: {
      ...ALPHA,
      [MAIN]: `export async function boot() { return import("@pome-sh/twin-alpha"); }\n`,
    },
    expect: "red",
    contains: "NO LONGER statically reachable",
  },
  {
    name: "every twin is checked, not just the first",
    files: {
      ...ALPHA,
      ...twin("beta"),
      [MAIN]:
        `${CHECKS_IMPORT}import { CHECKS as C2 } from "@pome-sh/twin-beta/checks";\n` +
        `import { seedSchema } from "@pome-sh/twin-beta";\nvoid C2; void seedSchema;\n`,
    },
    expect: "red",
    contains: "twin-beta",
  },
  {
    name: "a db.ts edge is red even without touching the root",
    files: {
      ...ALPHA,
      [MAIN]: `${CHECKS_IMPORT}import { x } from "../../../packages/twin-alpha/src/db.js";\nvoid x;\n`,
    },
    expect: "red",
    contains: "SQLite schema",
  },
  {
    name: "a tree with no twins at all is RED, not green",
    files: { [MAIN]: `export const x = 1;\n` },
    expect: "red",
    contains: "No packages/twin-*",
  },
]);
