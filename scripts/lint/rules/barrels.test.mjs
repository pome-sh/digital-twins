#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table. Case 4 is the one worth having: the
// barrel list is hand-kept, so a listed file that MOVED must red rather than
// quietly stop being checked.

import { defineCases } from "../harness.mjs";

// One of the paths the rule carries; the others behave identically.
const BARREL = "packages/wire/src/index.ts";
// The rest of the list has to exist too, or every case fails on a missing file
// instead of on its own subject.
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
    // The hand-kept list is the weak point: a listed barrel that moved must red,
    // not silently drop out of coverage.
    name: "a listed barrel that no longer exists is red, not skipped",
    files: tree(undefined),
    expect: "red",
    contains: "listed as a barrel but absent",
  },
]);
