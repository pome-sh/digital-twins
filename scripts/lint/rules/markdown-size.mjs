// SPDX-License-Identifier: Apache-2.0
//
// Front-door Markdown budgets. AGENTS.md was 134 KB of multi-kilobyte lines;
// the rewrite made it readable, and these ceilings keep it that way.
//
// Limits are taken from the current tracked front-door set (largest file ~19 KB,
// longest prose line 543 columns) and sit well below the former 134 KB / 9 KB-line
// shape. Broader code/module budgets are a different rule.
//
// Tracked files only (`git ls-files`). A `--root` that is not that tree's
// toplevel is RED, so a fixture cannot silently scan a parent repository.
//
// The only exemptions live in EXCEPTION_POLICY. There is no per-file allowlist
// and no header escape hatch — those go stale. A new exception is a new entry.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export const FILE_BYTE_LIMIT = 32_768;
export const PROSE_LINE_LIMIT = 600;

export const FRONT_DOOR = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "CONTRACT.md",
  "SECURITY.md",
  "docs/*.md",
  "cli/README.md",
  "packages/README.md",
  "packages/*/README.md",
  "skills/README.md",
  "skills/*/README.md",
];

const REQUIRED_FILES = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "CONTRACT.md",
  "SECURITY.md",
  "cli/README.md",
  "packages/README.md",
  "skills/README.md",
];

const REQUIRED_GLOBS = ["docs/*.md", "packages/*/README.md", "skills/*/README.md"];

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(\s*<?https?:\/\/[^>\s)]+>?[^)]*\)/gi;
const BARE_URL_RE = /https?:\/\/\S+/gi;

export const EXCEPTION_POLICY = [
  {
    id: "long-url",
    applies: "line",
    reason: "a URL cannot wrap without breaking the link",
    match: (_rel, line) => isLongBecauseOfUrl(line),
  },
  {
    id: "table-row",
    applies: "line",
    reason: "a markdown table row is a record, not prose",
    match: (_rel, _line, isTableRow) => isTableRow,
  },
  {
    id: "generated-changelog",
    applies: "file",
    reason: "release tooling writes changelog lines; wrapping them is a fight with the generator",
    match: (rel) => isGeneratedChangelog(rel),
  },
];

export default {
  name: "markdown-size",
  describe: `front-door Markdown stays under ${FILE_BYTE_LIMIT} bytes and ${PROSE_LINE_LIMIT}-column prose`,
  check(ctx) {
    assertGitRoot(ctx.root);
    const tracked = listTracked(ctx.root, FRONT_DOOR);
    const violations = [];
    let filesExempt = 0;
    let linesExempt = 0;

    for (const rel of REQUIRED_FILES) {
      if (!tracked.includes(rel)) {
        violations.push(`${rel}: not tracked — front-door Markdown cannot drop out of the scan`);
      }
    }
    for (const glob of REQUIRED_GLOBS) {
      const re = globToRe(glob);
      if (!tracked.some((rel) => re.test(rel))) {
        violations.push(`${glob}: no tracked file matches — a vanished scan set is not a clean tree`);
      }
    }

    for (const rel of tracked) {
      const text = ctx.read(ctx.abs(rel));
      const fileException = EXCEPTION_POLICY.find((entry) => entry.applies === "file" && entry.match(rel));
      if (fileException) {
        filesExempt += 1;
        continue;
      }

      // The byte ceiling is on the file as checked out. Normalize only after
      // measuring so CRLF cannot spend fewer bytes than it occupies on disk.
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > FILE_BYTE_LIMIT) {
        violations.push(
          `${rel}: ${bytes} bytes exceeds ${FILE_BYTE_LIMIT} — split the page or cut it; ` +
            `this budget exists so AGENTS.md cannot return to its former 134 KB form`,
        );
      }

      const lines = text.replace(/\r\n/g, "\n").split("\n");
      const tableRows = findTableRows(lines);
      const last = lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
      for (let index = 0; index < last; index += 1) {
        const line = lines[index];
        if (line.length <= PROSE_LINE_LIMIT) continue;
        const lineException = EXCEPTION_POLICY.find(
          (entry) => entry.applies === "line" && entry.match(rel, line, tableRows.has(index)),
        );
        if (lineException) {
          linesExempt += 1;
          continue;
        }
        violations.push(
          `${rel}:${index + 1}: ${line.length} columns exceeds ${PROSE_LINE_LIMIT}-column prose`,
        );
      }
    }

    return {
      violations,
      summary: `${tracked.length} tracked file(s), ${filesExempt} file exception(s), ${linesExempt} line exception(s)`,
    };
  },
};

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
      `not a git work tree: ${root}. This rule scans tracked Markdown only — run it from the repository root.`,
    );
  }
  if (realpathSync(toplevel) !== realpathSync(root)) {
    throw new Error(
      `git toplevel ${toplevel} is not ${root} — refusing to scan a parent repository.`,
    );
  }
}

function listTracked(root, pathspecs) {
  // `:(glob)` makes `*` match one path component. Default Git pathspecs let it
  // cross `/`, which would pull fixture READMEs into this front-door policy.
  const globPathspecs = pathspecs.map((pathspec) => `:(glob)${pathspec}`);
  const stdout = execFileSync("git", ["ls-files", "-z", "--", ...globPathspecs], {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean).map((rel) => rel.replaceAll("\\", "/"));
}

function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function isGeneratedChangelog(rel) {
  return /(^|\/)CHANGELOG\.md$/.test(rel.replaceAll("\\", "/"));
}

function findTableRows(lines) {
  const rows = new Set();
  for (let index = 1; index < lines.length; index += 1) {
    if (!isTableDelimiter(lines[index]) || !isTableRow(lines[index - 1])) continue;
    rows.add(index - 1);
    rows.add(index);
    for (let body = index + 1; body < lines.length && isTableRow(lines[body]); body += 1) {
      rows.add(body);
    }
  }
  return rows;
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

function isTableDelimiter(line) {
  const cells = line.trim().split("|").slice(1);
  if (line.trim().endsWith("|")) cells.pop();
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function isLongBecauseOfUrl(line) {
  if (!/https?:\/\//i.test(line)) return false;
  const leftover = line.replace(MARKDOWN_LINK_RE, "").replace(BARE_URL_RE, "");
  return leftover.length <= PROSE_LINE_LIMIT;
}
