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
    name: "a header below the first statement does not count",
    files: tree({ [SUBJECT]: `const a = 1;\n// file-size: buried where nobody reads it\n${lines(600)}` }),
    expect: "red",
    contains: "exceeds 500 LOC",
  },
  {
    name: "a header on the line after a shebang counts, because a shebang owns line 1",
    files: tree({
      [SUBJECT]: `#!/usr/bin/env node\n// file-size: the whole command surface in one place\n${lines(600)}`,
    }),
    expect: "green",
  },
  {
    // The shape every twin entrypoint has. Demanding one exact index reported a
    // missing header while the header sat two lines above the complaint.
    name: "a header below a shebang AND an SPDX line still counts",
    files: tree({
      [SUBJECT]: `#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\n// file-size: one boot path\n${lines(600)}`,
    }),
    expect: "green",
  },
  {
    name: "a header below SPDX with no shebang counts",
    files: tree({
      [SUBJECT]: `// SPDX-License-Identifier: Apache-2.0\n// file-size: one boot path\n${lines(600)}`,
    }),
    expect: "green",
  },
  {
    name: "a header under a shebang on a small file is RED too, not skipped",
    files: tree({ [SUBJECT]: `#!/usr/bin/env node\n// file-size: stale\n${lines(10)}` }),
    expect: "red",
    contains: "exempts nothing",
  },
  {
    // 500 content lines plus the trailing newline's empty string. Counting that
    // string reported 501 and called a conforming file a violation.
    name: "a file at exactly the limit passes, trailing newline not counted",
    files: tree({ [SUBJECT]: `${lines(499)}\n` }),
    expect: "green",
  },
  {
    name: "a shebang with no header on the line below it is still a violation",
    files: tree({ [SUBJECT]: `#!/usr/bin/env node\n${lines(600)}` }),
    expect: "red",
    contains: "exceeds 500 LOC",
  },
  {
    name: "a header on a module under the limit is RED — a stale exemption, not a free pass",
    files: tree({ [SUBJECT]: lines(10, "// file-size: a reason that stopped applying") }),
    expect: "red",
    contains: [SUBJECT, "exempts nothing"],
  },
  {
    name: "no module is exempt by name — the reason has to be in the file",
    files: tree({ "cli/src/cli/main.ts": lines(900) }),
    expect: "red",
    contains: "exceeds 500 LOC",
  },
  {
    name: "a scan directory that no longer exists is RED, not an empty pass",
    files: tree({ "packages/sdk/src/ok.ts": undefined }),
    expect: "red",
    contains: "scan director",
  },
]);
