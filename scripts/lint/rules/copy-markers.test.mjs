#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table at all, so nothing proved it could go
// red. Both markers are asserted, plus the two false-positive shapes that would
// get it deleted: a marker in a `.js` file (out of scope) and prose that merely
// mentions the word.

import { defineCases } from "../harness.mjs";

const SRC = "packages/twin-x/src/thing.ts";

defineCases("copy-markers", [
  {
    name: "a clean tree passes",
    files: { [SRC]: `export const thing = 1;\n` },
    expect: "green",
  },
  {
    name: "a `// Canonical:` marker is a violation, named with its line",
    files: { [SRC]: `export const a = 1;\n// Canonical: packages/twin-y/src/thing.ts\n` },
    expect: "red",
    contains: `${SRC}:2:`,
  },
  {
    name: "a `// Mirrors` marker is a violation",
    files: { [SRC]: "// Mirrors `packages/twin-y/src/thing.ts`\n" },
    expect: "red",
    contains: "Mirrors",
  },
  {
    name: "cli/src is in scope too, not just packages/",
    files: { "cli/src/thing.ts": `// Canonical: packages/twin-y/src/thing.ts\n` },
    expect: "red",
    contains: "cli/src/thing.ts",
  },
  {
    name: "prose that merely mentions the word is not a marker",
    files: { [SRC]: `// This is the canonical implementation; nothing mirrors it.\nexport const a = 1;\n` },
    expect: "green",
  },
]);
