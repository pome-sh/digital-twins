#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for task-format-doc. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

const DOC = "skills/pome-author-task/references/task-format.md";
const PARSER = "cli/src/task/parseTask.ts";

const GRAMMAR = "/^[-*]\\s+\\[(code|model)(?::([a-z][a-z0-9_-]*))?(\\s+always-scored)?\\]\\s+(.+)$/";
const OLD_GRAMMAR = "/^[-*]\\s+\\[(code|model)(?::([a-z][a-z0-9_-]*))?\\]\\s+(.+)$/";

const doc = (grammar) =>
  `# Task format\n\n## Success criteria markers\n\nThe exact line grammar is:\n\n` +
  `\`\`\`\n${grammar}\n\`\`\`\n\nThat is: a \`-\` or \`*\` bullet, …\n`;

const parser = (grammar) => `// Criterion marker grammar.\nconst CRITERION_LINE_RE =\n  ${grammar};\n`;

defineCases("task-format-doc", [
  {
    name: "green when the doc quotes the parser's grammar verbatim",
    files: { [DOC]: doc(GRAMMAR), [PARSER]: parser(GRAMMAR) },
    expect: "green",
  },
  {
    name: "red when the doc still quotes the pre-always-scored grammar",
    files: { [DOC]: doc(OLD_GRAMMAR), [PARSER]: parser(GRAMMAR) },
    expect: "red",
    contains: "is not the one cli/src/task/parseTask.ts runs",
  },
  {
    name: "red when the doc stops quoting a grammar at all",
    files: { [DOC]: "# Task format\n\nSee the parser for the grammar.\n", [PARSER]: parser(GRAMMAR) },
    expect: "red",
    contains: "no fenced criterion-grammar block",
  },
  {
    name: "red when the parser's constant is renamed out from under it",
    files: { [DOC]: doc(GRAMMAR), [PARSER]: `const CRITERION_MARKER_RE =\n  ${GRAMMAR};\n` },
    expect: "red",
    contains: "no `const CRITERION_LINE_RE",
  },
]);
