#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `lint-task-format-doc.mjs` (F-1299).
//
// Cases 3 and 4 are why this file exists rather than a "it went green once"
// note. The gate reads its two subjects out of two files by regex, and the
// cheapest way for it to stop doing its job is for one of those regexes to stop
// MATCHING — a doc that reformatted its fence, or a parser whose constant was
// renamed. Either would leave the gate with nothing to compare and, without
// these cases, nothing to say about it. So both are asserted RED.
//
// Each case builds a throwaway root holding just the two files and runs the
// real script against it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "lint-task-format-doc.mjs");

const GRAMMAR = "/^[-*]\\s+\\[(code|model)(?::([a-z][a-z0-9_-]*))?(\\s+always-scored)?\\]\\s+(.+)$/";
const OLD_GRAMMAR = "/^[-*]\\s+\\[(code|model)(?::([a-z][a-z0-9_-]*))?\\]\\s+(.+)$/";

const doc = (grammar) =>
  `# Task format\n\n## Success criteria markers\n\nThe exact line grammar is:\n\n` +
  `\`\`\`\n${grammar}\n\`\`\`\n\nThat is: a \`-\` or \`*\` bullet, …\n`;

const parser = (grammar) =>
  `// Criterion marker grammar (F-778).\nconst CRITERION_LINE_RE =\n  ${grammar};\n`;

function runAgainst({ doc: docText, parser: parserText }) {
  const root = mkdtempSync(join(tmpdir(), "task-format-doc-"));
  const files = {
    "skills/pome-author-task/references/task-format.md": docText,
    "cli/src/task/parseTask.ts": parserText,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
}

const cases = [
  {
    name: "green when the doc quotes the parser's grammar verbatim",
    input: { doc: doc(GRAMMAR), parser: parser(GRAMMAR) },
    expectExit: 0,
    expectOutput: /task-format-doc gate passed/,
  },
  {
    name: "red when the doc still quotes the pre-always-scored grammar",
    input: { doc: doc(OLD_GRAMMAR), parser: parser(GRAMMAR) },
    expectExit: 1,
    expectOutput: /is not the one cli\/src\/task\/parseTask\.ts runs/,
  },
  {
    name: "red when the doc stops quoting a grammar at all",
    input: {
      doc: "# Task format\n\nSee the parser for the grammar.\n",
      parser: parser(GRAMMAR),
    },
    expectExit: 1,
    expectOutput: /no fenced criterion-grammar block/,
  },
  {
    name: "red when the parser's constant is renamed out from under it",
    input: {
      doc: doc(GRAMMAR),
      parser: `const CRITERION_MARKER_RE =\n  ${GRAMMAR};\n`,
    },
    expectExit: 1,
    expectOutput: /no `const CRITERION_LINE_RE/,
  },
];

let failures = 0;
for (const testCase of cases) {
  const result = runAgainst(testCase.input);
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== testCase.expectExit) {
    console.error(
      `FAIL ${testCase.name}: expected exit ${testCase.expectExit}, got ${result.status}\n${output}`,
    );
    failures += 1;
    continue;
  }
  if (!testCase.expectOutput.test(output)) {
    console.error(
      `FAIL ${testCase.name}: output did not match ${testCase.expectOutput}\n${output}`,
    );
    failures += 1;
    continue;
  }
  console.log(`ok — ${testCase.name}`);
}

if (failures > 0) {
  console.error(`${failures} lint-task-format-doc case(s) failed.`);
  process.exit(1);
}
console.log(`lint-task-format-doc suite passed (${cases.length} cases).`);
