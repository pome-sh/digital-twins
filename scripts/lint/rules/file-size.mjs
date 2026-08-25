// SPDX-License-Identifier: Apache-2.0
//
// File-size ceiling. A missing scan root is RED, not an empty pass.
//
// One escape hatch: a `// file-size: <reason>` header on the first line, or the
// line after a shebang. The reason travels with the file, so it cannot go stale
// by rename and it is visible to whoever opens the module rather than only to
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

/** The header sits on line 1, or on line 2 where a shebang owns line 1. */
function declaredReason(lines) {
  const at = lines[0]?.startsWith("#!") ? 1 : 0;
  return FILE_SIZE_HEADER.test(lines[at] ?? "");
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
      if (lines.length <= FILE_SIZE_LIMIT) {
        if (stated) {
          violations.push(
            `${rel}: ${lines.length} lines is under the ${FILE_SIZE_LIMIT} LOC limit, so its ` +
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
        `${rel}: ${lines.length} lines exceeds ${FILE_SIZE_LIMIT} LOC — add a \`// file-size: <reason>\` header or split the module`,
      );
    }
    return { violations, summary: `${exempt} module(s) state a reason` };
  },
};
