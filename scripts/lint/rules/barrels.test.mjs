#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for barrels. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

const BARREL = "packages/wire/src/index.ts";
const OTHERS = [
  "packages/twin-gmail/src/index.ts",
  "packages/twin-gmail/src/domain/index.ts",
  "packages/twin-github/src/index.ts",
  "packages/twin-github/src/domain/index.ts",
  "packages/twin-linear/src/index.ts",
  "packages/twin-linear/src/domain/index.ts",
  "packages/twin-slack/src/index.ts",
  "packages/twin-slack/src/domain/index.ts",
  "packages/twin-stripe/src/index.ts",
  "packages/twin-stripe/src/domain/index.ts",
  "packages/adapter-claude-sdk/src/index.ts",
  "cli/src/contract/index.ts",
];

const tree = (barrel) => ({
  ...Object.fromEntries(OTHERS.map((path) => [path, `export { a } from "./a.js";\n`])),
  ...(barrel === undefined ? {} : { [BARREL]: barrel }),
});

defineCases("barrels", [
  {
    name: "a barrel that only re-exports passes",
    files: tree(`export { a } from "./a.js";\nexport type { B } from "./b.js";\n`),
    expect: "green",
  },
  {
    name: "a multi-line named re-export block passes",
    files: tree(`export {\n  a,\n  b,\n} from "./a.js";\n`),
    expect: "green",
  },
  {
    name: "logic in a barrel is a violation, quoting the offending line",
    files: tree(`export { a } from "./a.js";\nconst derived = a + 1;\n`),
    expect: "red",
    contains: ["found logic/prose in a barrel", "const derived = a + 1;"],
  },
  {
    name: "a listed barrel that no longer exists is red, not skipped",
    files: tree(undefined),
    expect: "red",
    contains: "listed as a barrel but absent",
  },
]);
