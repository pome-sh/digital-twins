// SPDX-License-Identifier: Apache-2.0
//
// The criterion grammar the authoring skill PROMISES must be the grammar the
// parser RUNS.
//
// `skills/pome-author-task/references/task-format.md` is a byte-identical
// mirror of pome-cloud's `apps/mcp/docs/task-format.md`, and pome-cloud gates
// its own copy. Nothing gated the mirror, so it sat a whole marker keyword
// behind while the cloud moved: the doc published a grammar under which
// `- [code always-scored] …` is not a criterion line at all, and a line the
// grammar does not match is skipped as prose. That is the silent criterion drop
// this rule closes, promised to authors in writing.
//
// A cross-repo byte diff is not runnable from this repo's CI — the canonical
// copy lives in another repository and this one has no checkout of it. What IS
// runnable is the one line of the doc that IS the grammar: it must be the
// `CRITERION_LINE_RE` literal in `cli/src/task/parseTask.ts`, character for
// character. That regex is itself required to stay byte-identical to the hosted
// parser's, so pinning the doc to the local parser pins it to the hosted
// grammar too.
//
// Deliberately narrow. It does not check the doc's prose, its worked examples,
// or the rest of the mirror; a gate over the whole file would be a cross-repo
// diff wearing a disguise. It pins the claim that went stale.

const DOC_PATH = "skills/pome-author-task/references/task-format.md";
const PARSER_PATH = "cli/src/task/parseTask.ts";

// The doc quotes the grammar in a bare fenced block holding nothing but the
// literal. Anchored on `/^[-*]` — the only thing in the document that opens a
// criterion-line regex — rather than on a line number or a heading.
const DOC_GRAMMAR_FENCE_RE = /^```\s*\n(\/\^\[-\*\][^\n]*)\n```$/m;
// `const CRITERION_LINE_RE =` and the literal, which sits on the next line once
// the formatter wraps it.
const PARSER_GRAMMAR_RE = /const CRITERION_LINE_RE\s*=\s*(\/[^\n]*\/[a-z]*);/;

export default {
  name: "task-format-doc",
  describe: "the skill reference quotes the criterion grammar the parser runs",
  check(ctx) {
    // A rule that shrugs when it cannot find its subject passes for the same
    // reason a rule over a corpus that stopped being found passes.
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
