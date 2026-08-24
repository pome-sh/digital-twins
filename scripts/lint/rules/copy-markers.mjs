// SPDX-License-Identifier: Apache-2.0
//
// Copy-marker gate (M6). Cross-package file copies are not allowed in OSS
// packages; shared code should move through published packages instead.

const ALLOWLIST = new Set([]);

const MARKER_RES = [/^\s*\/\/\s*Canonical:\s/i, /^\s*\/\/\s*Mirrors\s+[`'"]/i];

export default {
  name: "copy-markers",
  describe: "no cross-package file-copy markers in OSS packages",
  check(ctx) {
    const violations = [];
    for (const file of ctx.files({ dirs: ["packages", "cli/src"], ext: [".ts", ".tsx"] })) {
      const rel = ctx.rel(file);
      if (ALLOWLIST.has(rel)) continue;
      ctx.read(file)
        .split("\n")
        .forEach((line, i) => {
          if (MARKER_RES.some((re) => re.test(line))) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    return {
      violations,
      summary: `${ALLOWLIST.size} allowlisted mirror file(s)`,
      hint:
        "Add to this rule's ALLOWLIST only for an intentional mirror; otherwise move the shared\n" +
        "code into a published package and import it.",
    };
  },
};
