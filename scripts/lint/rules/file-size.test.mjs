#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table. What is worth proving is that the
// escape hatch works only in the one place it is documented to: a
// `// file-size:` header on the FIRST line. A header further down the file would
// be an escape hatch nobody could find by reading the top of the module.

import { defineCases } from "../harness.mjs";

const SRC = "cli/src/big.ts";
const lines = (count, first = "") => [first, ...Array.from({ length: count }, (_, i) => `const x${i} = ${i};`)].join("\n");

defineCases("file-size", [
  {
    name: "a module under the limit passes",
    files: { [SRC]: lines(10) },
    expect: "green",
  },
  {
    name: "a module over the limit with no header is a violation, named with its length",
    files: { [SRC]: lines(600) },
    expect: "red",
    contains: ["cli/src/big.ts", "exceeds 500 LOC"],
  },
  {
    name: "a `// file-size:` header on the first line is the documented escape hatch",
    files: { [SRC]: lines(600, "// file-size: one table, split adds indirection for no gain") },
    expect: "green",
  },
  {
    name: "a bare `// file-size:` with no reason does not count",
    files: { [SRC]: lines(600, "// file-size:") },
    expect: "red",
    contains: "exceeds 500 LOC",
  },
  {
    name: "a header that is not on the first line does not count",
    files: { [SRC]: `const a = 1;\n// file-size: buried where nobody reads it\n${lines(600)}` },
    expect: "red",
    contains: "exceeds 500 LOC",
  },
]);
