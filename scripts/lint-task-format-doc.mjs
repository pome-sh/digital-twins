// SPDX-License-Identifier: Apache-2.0
//
// F-1299 — the criterion grammar the authoring skill PROMISES must be the
// grammar the parser RUNS.
//
// `skills/pome-author-task/references/task-format.md` is a byte-identical
// mirror of pome-cloud's `apps/mcp/docs/task-format.md`, and pome-cloud gates
// its own copy (`apps/mcp/test/task-format-doc.test.ts`). Nothing gated the
// mirror, so it sat a whole marker keyword behind for the length of F-1296: the
// doc published a grammar under which `- [code always-scored] …` is not a
// criterion line at all, and a line the grammar does not match is skipped as
// prose. That is the silent criterion drop F-1299 closes, promised to authors
// in writing.
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
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOC_PATH = "skills/pome-author-task/references/task-format.md";
const PARSER_PATH = "cli/src/task/parseTask.ts";

// The doc quotes the grammar in a bare fenced block holding nothing but the
// literal. Anchored on `/^[-*]` — the only thing in the document that opens a
// criterion-line regex — rather than on a line number or a heading.
const DOC_GRAMMAR_FENCE_RE = /^```\s*\n(\/\^\[-\*\][^\n]*)\n```$/m;
// `const CRITERION_LINE_RE =` and the literal, which sits on the next line once
// the formatter wraps it.
const PARSER_GRAMMAR_RE = /const CRITERION_LINE_RE\s*=\s*(\/[^\n]*\/[a-z]*);/;

function main() {
  const root = process.cwd();
  const doc = readFileSync(join(root, DOC_PATH), "utf8");
  const parser = readFileSync(join(root, PARSER_PATH), "utf8");

  // A gate that shrugs when it cannot find its subject passes for the same
  // reason a gate over a corpus that stopped being found passes (F-989).
  const docMatch = doc.match(DOC_GRAMMAR_FENCE_RE);
  if (!docMatch) {
    console.error(
      `${DOC_PATH} has no fenced criterion-grammar block (a \`\`\` fence whose only ` +
        `line is the /^[-*]…/ regex). The doc either stopped quoting the grammar or ` +
        `reformatted the block — this gate cannot pin what it cannot find.`,
    );
    process.exit(1);
  }
  const parserMatch = parser.match(PARSER_GRAMMAR_RE);
  if (!parserMatch) {
    console.error(
      `${PARSER_PATH} has no \`const CRITERION_LINE_RE = /…/;\` declaration. If the ` +
        `parser's grammar moved or was renamed, move this gate with it.`,
    );
    process.exit(1);
  }

  const [, docGrammar] = docMatch;
  const [, parserGrammar] = parserMatch;
  if (docGrammar !== parserGrammar) {
    console.error(
      `The criterion grammar in ${DOC_PATH} is not the one ${PARSER_PATH} runs:\n` +
        `  doc:    ${docGrammar}\n` +
        `  parser: ${parserGrammar}\n` +
        `A line the parser's regex does not match is skipped as prose, so a doc that ` +
        `promises a wider grammar than the parser accepts tells authors to write ` +
        `criteria that silently never get scored. Update the doc — and keep it ` +
        `byte-identical to pome-cloud's apps/mcp/docs/task-format.md, its canonical copy.`,
    );
    process.exit(1);
  }

  console.log(`task-format-doc gate passed — the skill reference quotes ${docGrammar}`);
}

// Never a basename compare — `import.meta.url.endsWith(basename(process.argv[1]))`
// is satisfied by any file of that name anywhere on disk, weaker even than
// an unresolved full-path compare. Realpath'd on both sides instead — node
// resolves symlinks before deriving `import.meta.url`, so a bare compare
// misses through a symlinked checkout (F-1488) — and a guard miss while
// invoked as this file throws rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("lint-task-format-doc.mjs")) {
  throw new Error(`lint-task-format-doc.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
