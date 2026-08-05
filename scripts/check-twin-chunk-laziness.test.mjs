#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-twin-chunk-laziness.mjs` (F-1306).
//
// The gate exists because a laziness claim went five releases without anyone
// checking it, so the thing most worth proving is that this gate CAN go red —
// and goes red on the exact shapes that shipped: an indirect chain through two
// CLI modules (how `parseTask.ts` did it), and a package-root import for a value
// that a leaf subpath already exports.
//
// Cases 5 and 6 guard the two ways a gate like this quietly stops working: a
// scaffold's template-literal source counted as a real edge (false red, and the
// gate gets deleted), and a type-only import counted as a runtime edge (same).
// Each case builds a throwaway tree and runs the real script against it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-twin-chunk-laziness.mjs");

/** A minimal twin: a package root that re-exports domain + seed, a db module, a
 *  domain module, a zod-free `seed.ts` leaf, and a `checks.ts` the gate requires
 *  to stay reachable. */
function twinFiles(name) {
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

function runAgainst(cliFiles, { twins = ["alpha"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "twin-laziness-"));
  const files = { ...cliFiles };
  for (const twin of twins) Object.assign(files, twinFiles(twin));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

let failures = 0;
function check(name, { files, twins, expect, contains }) {
  const { code, out } = runAgainst(files, { twins });
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

const MAIN = "cli/src/cli/main.ts";
const CHECKS_IMPORT = `import { CHECKS } from "@pome-sh/twin-alpha/checks";\nvoid CHECKS;\n`;

check("1. the shipped shape is green: `/checks` statically, domain via import()", {
  files: {
    [MAIN]: `${CHECKS_IMPORT}export async function boot() { return import("@pome-sh/twin-alpha"); }\n`,
  },
  expect: "green",
});

check("2. a direct package-root import is red", {
  files: {
    [MAIN]: `${CHECKS_IMPORT}import { seedSchema } from "@pome-sh/twin-alpha";\nvoid seedSchema;\n`,
  },
  expect: "red",
  contains: "package root",
});

check("3. an INDIRECT root import two CLI modules deep is red (the F-1306 shape)", {
  files: {
    [MAIN]: `${CHECKS_IMPORT}import { parseTask } from "../task/parseTask.js";\nvoid parseTask;\n`,
    "cli/src/task/parseTask.ts": `import { schema } from "./taskSchema.js";\nexport const parseTask = () => schema;\n`,
    "cli/src/task/taskSchema.ts": `import { seedSchema } from "@pome-sh/twin-alpha";\nexport const schema = seedSchema;\n`,
  },
  expect: "red",
  contains: "taskSchema.ts",
});

check("4. the same value read from the `/seed` leaf is green", {
  files: {
    [MAIN]: `${CHECKS_IMPORT}import { parseTask } from "../task/parseTask.js";\nvoid parseTask;\n`,
    "cli/src/task/parseTask.ts": `import { schema } from "./taskSchema.js";\nexport const parseTask = () => schema;\n`,
    "cli/src/task/taskSchema.ts": `import { seedSchema } from "@pome-sh/twin-alpha/seed";\nexport const schema = seedSchema;\n`,
  },
  expect: "green",
});

check("5. a root import inside a SCAFFOLD template literal is not an edge", {
  files: {
    [MAIN]:
      `${CHECKS_IMPORT}export const scaffold = \`\n` +
      `import { seedSchema } from "@pome-sh/twin-alpha";\n` +
      `console.log(seedSchema);\n\`;\n`,
  },
  expect: "green",
});

check("6. a type-only root import is not a runtime edge", {
  files: {
    [MAIN]:
      `${CHECKS_IMPORT}import type { seedSchema } from "@pome-sh/twin-alpha";\n` +
      `import { type seedSchema as S2 } from "@pome-sh/twin-alpha";\n` +
      `export type A = typeof seedSchema;\nexport type B = typeof S2;\n`,
  },
  expect: "green",
});

check("7. dropping a twin's checks from the static graph is red", {
  files: { [MAIN]: `export async function boot() { return import("@pome-sh/twin-alpha"); }\n` },
  expect: "red",
  contains: "NO LONGER statically reachable",
});

check("8. every twin is checked, not just the first", {
  files: {
    [MAIN]:
      `${CHECKS_IMPORT}import { CHECKS as C2 } from "@pome-sh/twin-beta/checks";\n` +
      `import { seedSchema } from "@pome-sh/twin-beta";\nvoid C2; void seedSchema;\n`,
  },
  twins: ["alpha", "beta"],
  expect: "red",
  contains: "twin-beta",
});

check("9. a db.ts edge is red even without touching the root", {
  files: {
    [MAIN]: `${CHECKS_IMPORT}import { x } from "../../../packages/twin-alpha/src/db.js";\nvoid x;\n`,
  },
  expect: "red",
  contains: "SQLite schema",
});

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log(`\ncheck-twin-chunk-laziness.test: 9 cases passed.`);
