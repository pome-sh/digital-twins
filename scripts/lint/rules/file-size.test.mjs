#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for file-size. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

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
