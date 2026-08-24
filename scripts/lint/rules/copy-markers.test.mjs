#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table, so nothing proved it could go red.
// Both markers are asserted, plus the two false-positive shapes that would get
// it deleted: a marker in prose, and a scoped-out file. The last case pins the
// other direction — a scan directory that has vanished must be RED, because a
// rule that walks nothing prints the same line as a rule that found nothing.

import { defineCases } from "../harness.mjs";

const SRC = "packages/twin-x/src/thing.ts";
const CLI = "cli/src/thing.ts";

/** Both scanned directories present and clean, then `overrides` applied. A key
 *  mapped to `undefined` is dropped, to express "this file does not exist". */
const tree = (overrides = {}) =>
  Object.fromEntries(
    Object.entries({
      [SRC]: `export const thing = 1;\n`,
      [CLI]: `export const cli = 1;\n`,
      ...overrides,
    }).filter(([, body]) => body !== undefined),
  );

defineCases("copy-markers", [
  {
    name: "a clean tree passes",
    files: tree(),
    expect: "green",
  },
  {
    name: "a `// Canonical:` marker is a violation, named with its line",
    files: tree({ [SRC]: `export const a = 1;\n// Canonical: packages/twin-y/src/thing.ts\n` }),
    expect: "red",
    contains: `${SRC}:2:`,
  },
  {
    name: "a `// Mirrors` marker is a violation",
    files: tree({ [SRC]: "// Mirrors `packages/twin-y/src/thing.ts`\n" }),
    expect: "red",
    contains: "Mirrors",
  },
  {
    name: "cli/src is in scope too, not just packages/",
    files: tree({ [CLI]: `// Canonical: packages/twin-y/src/thing.ts\n` }),
    expect: "red",
    contains: "cli/src/thing.ts",
  },
  {
    name: "prose that merely mentions the word is not a marker",
    files: tree({ [SRC]: `// This is the canonical implementation; nothing mirrors it.\nexport const a = 1;\n` }),
    expect: "green",
  },
  {
    // A `.js` file in a scanned directory is out of scope: the rule reads
    // TypeScript sources only.
    name: "a marker in a non-TypeScript file is out of scope",
    files: tree({ "packages/twin-x/src/thing.js": `// Canonical: elsewhere\n` }),
    expect: "green",
  },
  {
    name: "a scan directory that no longer exists is RED, not an empty pass",
    files: tree({ [CLI]: undefined }),
    expect: "red",
    contains: "scan directory not found: cli/src",
  },
]);
