// SPDX-License-Identifier: Apache-2.0
//
// The task-format doc must stay in step with the parser.

const DOC_PATH = "skills/pome-author-task/references/task-format.md";
const PARSER_PATH = "cli/src/task/parseTask.ts";

const DOC_GRAMMAR_FENCE_RE = /^```\s*\n(\/\^\[-\*\][^\n]*)\n```$/m;
const PARSER_GRAMMAR_RE = /const CRITERION_LINE_RE\s*=\s*(\/[^\n]*\/[a-z]*);/;

export default {
  name: "task-format-doc",
  describe: "the skill reference quotes the criterion grammar the parser runs",
  check(ctx) {
    const docMatch = ctx.readRel(DOC_PATH).match(DOC_GRAMMAR_FENCE_RE);
    if (!docMatch) {
      return {
        violations: [
          `${DOC_PATH} has no fenced criterion-grammar block (a \`\`\` fence whose only line is the ` +
            `/^[-*]…/ regex). The doc either stopped quoting the grammar or reformatted the block — ` +
            `this rule cannot pin what it cannot find.`,
        ],
      };
    }

    const parserMatch = ctx.readRel(PARSER_PATH).match(PARSER_GRAMMAR_RE);
    if (!parserMatch) {
      return {
        violations: [
          `${PARSER_PATH} has no \`const CRITERION_LINE_RE = /…/;\` declaration. If the parser's ` +
            `grammar moved or was renamed, move this rule with it.`,
        ],
      };
    }

    const [, docGrammar] = docMatch;
    const [, parserGrammar] = parserMatch;
    if (docGrammar === parserGrammar) {
      return { violations: [], summary: `the skill reference quotes ${docGrammar}` };
    }
    return {
      violations: [
        `The criterion grammar in ${DOC_PATH} is not the one ${PARSER_PATH} runs:`,
        `  doc:    ${docGrammar}`,
        `  parser: ${parserGrammar}`,
      ],
      hint:
        "A line the parser's regex does not match is skipped as prose, so a doc that promises a\n" +
        "wider grammar than the parser accepts tells authors to write criteria that silently never\n" +
        "get scored. Update the doc — and keep it byte-identical to pome-cloud's\n" +
        "apps/mcp/docs/task-format.md, its canonical copy.",
    };
  },
};
