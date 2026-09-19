// SPDX-License-Identifier: Apache-2.0
//
// README.md is the walkthrough. docs.pome.sh is the reference. This rule holds
// the two mechanical halves of that split (F-1844); the taste half is a human
// reading the rendered page, which no rule can carry.
//
// `markdown-size` keeps front-door Markdown from growing back to 134 KB. This
// rule is narrower and much tighter, and it applies to one file: the page a
// stranger lands on. A reader who has succeeded once can scroll a wide block.
// A reader on the first screen sees a clipped command and leaves.
//
// BOTH LIMITS ARE MEASURED, not chosen. Rendered 2026-09-17 on github.com at a
// 1440px viewport, README.md as it stood on main:
//
//   - `article.markdown-body pre` is 762px of content at 8.19px per monospace
//     column, so a code block SCROLLS SIDEWAYS PAST 93 COLUMNS. Three of the
//     five blocks overflowed: the `twin start` output at 144 columns, the tape
//     at 112, the CI job at 108. One of the clipped lines was the `claude mcp
//     add` one-liner, the single most important line on the page.
//   - Prose is an 838px column. A paragraph of N characters that GitHub laid
//     out in L lines pins the line capacity C to (N/L, N/(L-1)]. Measured on
//     main: 295 characters took 3 lines, so C > 98; 335 took 4, so C <= 112.
//     105 is the middle of that interval and the only figure consistent with
//     every paragraph on the page.
//
// So 80 columns is the code ceiling with headroom under the 93-column cliff,
// and it is also the width the twin's own terminal output was written for.
// 105 characters is one rendered line of prose, and three of them is the
// paragraph budget. The interval matters more than the midpoint: a budget
// under 295 would red a paragraph that renders in three lines, and the first
// false red is what teaches a writer to stop reading the rule.
//
// The prose budget counts RENDERED characters. A link's href, a backtick and a
// bold marker occupy source columns and no screen width, so they are stripped
// before measuring — otherwise the rule would push writers away from linking.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Columns a code block may occupy before github.com scrolls it sideways. */
export const CODE_COLUMN_LIMIT = 80;
/** Rendered characters github.com fits on one line of README prose. */
export const RENDERED_LINE_COLUMNS = 105;
/** Rendered lines one paragraph or list item may occupy. */
export const PROSE_LINE_BUDGET = 3;
export const PROSE_CHAR_LIMIT = RENDERED_LINE_COLUMNS * PROSE_LINE_BUDGET;

/** The one file this rule governs: the page a stranger lands on. */
export const WALKTHROUGH = "README.md";

export default {
  name: "readme-readability",
  describe: `README.md code blocks stay under ${CODE_COLUMN_LIMIT} columns and prose under ${PROSE_LINE_BUDGET} rendered lines`,
  check(ctx) {
    assertGitRoot(ctx.root);
    if (!listTracked(ctx.root, WALKTHROUGH).includes(WALKTHROUGH)) {
      throw new Error(
        `${WALKTHROUGH} is not tracked — the front door cannot drop out of its own readability gate.`,
      );
    }

    const text = ctx.read(ctx.abs(WALKTHROUGH)).replace(/\r\n/g, "\n");
    const violations = [];
    const { codeLines, blocks } = parse(text);

    for (const { line, number } of codeLines) {
      if (line.length <= CODE_COLUMN_LIMIT) continue;
      violations.push(
        `${WALKTHROUGH}:${number}: ${line.length} columns in a code block exceeds ${CODE_COLUMN_LIMIT} — ` +
          `github.com scrolls a block past 93 columns, so this line is cut in half on the rendered page. ` +
          `Wrap it (\`\\\` for shell, a line break for JSON) or move it into a <details>.`,
      );
    }

    for (const block of blocks) {
      const rendered = renderedText(block.text);
      if (rendered.length <= PROSE_CHAR_LIMIT) continue;
      const lines = Math.ceil(rendered.length / RENDERED_LINE_COLUMNS);
      violations.push(
        `${WALKTHROUGH}:${block.number}: ${rendered.length} rendered characters is about ${lines} lines, ` +
          `over the ${PROSE_LINE_BUDGET}-line budget (${PROSE_CHAR_LIMIT}). ` +
          `Split it, or move the sentence answering a question the reader has not asked yet to ` +
          `docs.pome.sh or a <details>.\n    ${rendered.slice(0, 72)}…`,
      );
    }

    return {
      violations,
      summary: `${WALKTHROUGH}: ${codeLines.length} code line(s), ${blocks.length} prose block(s)`,
    };
  },
};

/**
 * Split the page into code lines and prose blocks.
 *
 * A prose block is a run of consecutive lines that renders as one paragraph or
 * one list item. Table rows are records rather than prose and are skipped, as
 * they are in `markdown-size`. Raw HTML counts for what it paints: a tag that
 * renders nothing separates blocks, and a tag wrapped around text is prose.
 */
function parse(text) {
  const lines = text.split("\n");
  const codeLines = [];
  const blocks = [];
  let fence = null;
  let current = null;

  const flush = () => {
    if (current && current.text.trim() !== "") blocks.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);

    if (fence) {
      // A closing fence may be followed only by whitespace (CommonMark §4.5).
      // "```js" inside a fenced block is content, and closing on it would
      // hand every later code line to the prose check instead of this one.
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ""
      ) {
        fence = null;
      } else {
        codeLines.push({ line, number });
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      continue;
    }
    if (line.trim() === "" || isHeading(line) || isTableRow(line)) {
      flush();
      continue;
    }
    // Raw HTML is judged by what it paints. A line that renders nothing —
    // `<div align="center">`, an `<img>`, a closing `</p>` — separates blocks.
    // A line that renders text is prose and pays the budget like any other:
    // skipping it wholesale let a `<p>` paragraph of any length through.
    if (isHtml(line) && renderedText(line) === "") {
      flush();
      continue;
    }
    // A block-level tag starts a new paragraph; an inline one (`<code>`, `<a>`)
    // on a continuation line is part of the paragraph it sits in, exactly as
    // CommonMark decides which HTML may interrupt a paragraph.
    if (isListItem(line) || isBlockHtml(line) || current === null) {
      flush();
      current = { number, text: line };
      continue;
    }
    current.text += ` ${line}`;
  }
  flush();
  return { codeLines, blocks };
}

const isHeading = (line) => /^\s{0,3}#{1,6}\s/.test(line);
const isListItem = (line) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
const isHtml = (line) => /^\s*<(?:\/?[a-zA-Z]|!--)/.test(line);
const isBlockHtml = (line) =>
  /^\s*<\/?(?:p|div|h[1-6]|details|summary|blockquote|center|section|article|header|footer|figure|figcaption|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|hr)\b/i.test(
    line,
  );

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

/** The text github.com paints, with the markup that costs no screen width removed. */
function renderedText(source) {
  return stripTags(
    source
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
  )
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove HTML comments and tags, repeatedly.
 *
 * One pass is not enough for either: `<<span>span>` becomes `<span>`, and
 * `<!-<!-- x -->- y -->` becomes `<!-- y -->`. A single-pass strip would then
 * charge the budget for markup that renders as nothing. Comments and tags go
 * through the same loop so neither can be reassembled by removing the other.
 * Each pass strictly shortens the string or changes nothing, so this
 * terminates.
 *
 * Whatever `<` survives the loop is literal text, and github.com paints it:
 * an unterminated `<!--` inside a paragraph renders as `&lt;!--`, verified
 * against GitHub's own /markdown endpoint. So it is not stripped — that would
 * hide characters the reader sees — but swapped for a same-width stand-in,
 * which keeps the count honest and leaves nothing that looks like markup.
 */
function stripTags(text) {
  let out = text;
  let previous;
  do {
    previous = out;
    out = out.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-zA-Z][^>]*>/g, "");
  } while (out !== previous);
  return out.replace(/</g, "\u2039");
}

function assertGitRoot(root) {
  let toplevel;
  try {
    toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `not a git work tree: ${root}. This rule scans the tracked README only — run it from the repository root.`,
    );
  }
  if (realpathSync(toplevel) !== realpathSync(root)) {
    throw new Error(`git toplevel ${toplevel} is not ${root} — refusing to scan a parent repository.`);
  }
}

function listTracked(root, pathspec) {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", `:(glob)${pathspec}`], {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean).map((rel) => rel.replaceAll("\\", "/"));
}
