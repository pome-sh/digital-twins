#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for copy-markers. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

const SRC = "packages/twin-x/src/thing.ts";
const CLI = "cli/src/thing.ts";

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
