#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table. The sanctioned exceptions are the
// part worth pinning: they are the whole reason the rule is not a plain grep,
// and an exception that silently widened would let the retired spelling back in.

import { defineCases } from "../harness.mjs";

defineCases("legacy-markers", [
  {
    name: "current [code]/[model] markers pass",
    files: { "cli/tasks/a.md": "- [code] a thing happened\n- [model:github] another\n" },
    expect: "green",
  },
  {
    name: "a reintroduced [D] marker is a violation, named with its line",
    files: { "cli/tasks/a.md": "- [code] fine\n- [D] retired spelling\n" },
    expect: "red",
    contains: "cli/tasks/a.md:2:",
  },
  {
    name: "the scoped forms [D:<twin>] and [P:<twin>] are violations too",
    files: { "docs/notes.md": "- [D:github] one\n- [P:slack] two\n" },
    expect: "red",
    contains: "docs/notes.md:1:",
  },
  {
    name: "the parser's own legacy-detection code may name the retired form",
    files: {
      "cli/src/task/parseTask.ts": `const HINT = "write [code]/[model], not [D]/[P]";\n`,
    },
    expect: "green",
  },
  {
    // Release notes are records, not current spelling, and are never rewritten.
    name: "a CHANGELOG is a record, not authored spelling",
    files: { "packages/wire/CHANGELOG.md": "## 0.1.0\n\n- renamed [D] to [code]\n" },
    expect: "green",
  },
  {
    // The allowlist is by exact path, so the parser's NEIGHBOUR is not covered by
    // the parser's exception.
    name: "an unrelated source file may not name the retired form",
    files: { "cli/src/task/other.ts": `const HINT = "not [D]";\n` },
    expect: "red",
    contains: "cli/src/task/other.ts",
  },
]);
