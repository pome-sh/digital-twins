// SPDX-License-Identifier: Apache-2.0
//
// File-size ceiling. A missing scan root is RED, not an empty pass.
//
// One escape hatch: a `// file-size: <reason>` header in the file's leading
// comment block. The reason travels with the file, so it cannot go stale by
// rename and it is visible to whoever opens the module rather than only to
// whoever opens this rule.
//
// A header on a file that no longer exceeds the limit is RED, the same way
// `barrels` reds on an absent barrel and `route-inputs` reds on an exemption
// matching nothing. An exemption nobody has to re-justify is an exemption
// forever, and this rule used to carry three that had stopped meaning anything.
//
// The count includes comment lines on purpose: the ceiling is about how much
// one file asks a reader to hold at once, and prose is part of that.

const FILE_SIZE_LIMIT = 500;
const FILE_SIZE_HEADER = /^\/\/\s*file-size:\s*.+/;

// How far into the file the header may sit: shebang, SPDX, and the header itself
// in either order, plus a blank line. Deliberately small.
const LEADING_BLOCK_LINES = 4;

const SCAN_DIRS = [
  "packages/twin-gmail/src",
  "packages/twin-github/src",
  "packages/twin-linear/src",
  "packages/twin-slack/src",
  "packages/twin-stripe/src",
  "packages/wire/src",
  "packages/sdk/src",
  "packages/adapter-claude-sdk/src",
  "cli/src",
];

/** The header sits in the file's leading comment block, so it can go above or
 *  below the SPDX line and after a shebang — the twin entrypoints are
 *  `#!` then SPDX, and demanding one exact index there reports a missing header
 *  while the header is visibly two lines up. Bounded to the block so a
 *  `// file-size:` written mid-file cannot exempt anything. */
function declaredReason(lines) {
  for (const raw of lines.slice(0, LEADING_BLOCK_LINES)) {
    const line = raw.trim();
    if (FILE_SIZE_HEADER.test(line)) return true;
    if (line === "" || line.startsWith("#!") || line.startsWith("//")) continue;
    return false;
  }
  return false;
}

/** Content lines, ignoring the trailing empty string a final newline leaves.
 *  Counting it made the reported length one more than the file has, which read
 *  as an off-by-one in every violation message. */
function lineCount(lines) {
  return lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export default {
  name: "file-size",
  describe: `modules over ${FILE_SIZE_LIMIT} LOC state a reason or get split`,
  check(ctx) {
    const violations = [];
    let exempt = 0;
    for (const file of ctx.files({ dirs: SCAN_DIRS, ext: [".ts", ".tsx"] })) {
      const rel = ctx.rel(file);
      const lines = ctx.read(file).split("\n");
      const stated = declaredReason(lines);
      const count = lineCount(lines);
      if (count <= FILE_SIZE_LIMIT) {
        if (stated) {
          violations.push(
            `${rel}: ${count} lines is under the ${FILE_SIZE_LIMIT} LOC limit, so its ` +
              `\`// file-size:\` header exempts nothing — drop the header.`,
          );
        }
        continue;
      }
      if (stated) {
        exempt += 1;
        continue;
      }
      violations.push(
        `${rel}: ${count} lines exceeds ${FILE_SIZE_LIMIT} LOC — add a \`// file-size: <reason>\` header or split the module`,
      );
    }
    return { violations, summary: `${exempt} module(s) state a reason` };
  },
};
