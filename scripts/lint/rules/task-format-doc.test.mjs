#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Cases 3 and 4 are why this table exists rather than a "it went green once"
// note. The rule reads its two subjects out of two files by regex, and the
// cheapest way for it to stop doing its job is for one of those regexes to stop
// MATCHING — a doc that reformatted its fence, or a parser whose constant was
// renamed. Either would leave the rule with nothing to compare and, without
// these cases, nothing to say about it. So both are asserted RED.

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
