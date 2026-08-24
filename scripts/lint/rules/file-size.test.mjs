#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table. What is worth proving is that the
// escape hatch works only in the one place it is documented to: a
// `// file-size:` header on the FIRST line. A header further down the file would
// be an escape hatch nobody could find by reading the top of the module.
//
// The last case pins the other direction — a scan directory that has vanished
// must be RED, because a rule that walks nothing prints the same line as a rule
// that found nothing.

import { defineCases } from "../harness.mjs";

// Every directory the rule is told to walk. All of them have to exist, or the
// case fails on a missing scan root instead of on its own subject.
const SCAN_DIRS = [
  "packages/twin-gmail/src",
  "packages/twin-github/src",
  "packages/twin-linear/src",
  "packages/twin-slack/src",
  "packages/twin-stripe/src",
  "packages/wire/src",
  "packages/sdk/src",
  "packages/adapter-claude-sdk/src",
  "cli/src",
];

const SUBJECT = "cli/src/big.ts";
const lines = (count, first = "") =>
  [first, ...Array.from({ length: count }, (_, index) => `const x${index} = ${index};`)].join("\n");

/** Every scan directory present and trivially clean, then `overrides` applied.
 *  A key mapped to `undefined` is dropped, to express "this file does not exist". */
const tree = (overrides = {}) =>
  Object.fromEntries(
    Object.entries({
      ...Object.fromEntries(SCAN_DIRS.map((dir) => [`${dir}/ok.ts`, `export const ok = 1;\n`])),
      ...overrides,
    }).filter(([, body]) => body !== undefined),
  );

defineCases("file-size", [
  {
    name: "a module under the limit passes",
    files: tree({ [SUBJECT]: lines(10) }),
    expect: "green",
  },
  {
    name: "a module over the limit with no header is a violation, named with its length",
    files: tree({ [SUBJECT]: lines(600) }),
    expect: "red",
    contains: [SUBJECT, "exceeds 500 LOC"],
  },
  {
    name: "a `// file-size:` header on the first line is the documented escape hatch",
    files: tree({ [SUBJECT]: lines(600, "// file-size: one table, split adds indirection for no gain") }),
    expect: "green",
  },
  {
    name: "a bare `// file-size:` with no reason does not count",
    files: tree({ [SUBJECT]: lines(600, "// file-size:") }),
    expect: "red",
    contains: "exceeds 500 LOC",
  },
  {
    name: "a header that is not on the first line does not count",
    files: tree({ [SUBJECT]: `const a = 1;\n// file-size: buried where nobody reads it\n${lines(600)}` }),
    expect: "red",
    contains: "exceeds 500 LOC",
  },
  {
    // Existing debt, allowlisted by exact path. The list should only shrink.
    name: "an allowlisted module is exempt at any length",
    files: tree({ "cli/src/cli/main.ts": lines(900) }),
    expect: "green",
  },
  {
    name: "a scan directory that no longer exists is RED, not an empty pass",
    files: tree({ "packages/sdk/src/ok.ts": undefined }),
    expect: "red",
    contains: "scan director",
  },
]);
