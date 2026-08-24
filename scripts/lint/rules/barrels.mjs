// SPDX-License-Identifier: Apache-2.0
//
// A barrel index re-exports and does nothing else. Logic in a barrel is logic
// every importer of the package root pays for, whatever subpath they wanted.

const BARREL_PATHS = [
  "packages/twin-gmail/src/index.ts",
  "packages/twin-gmail/src/domain/index.ts",
  "packages/twin-github/src/index.ts",
  "packages/twin-github/src/domain/index.ts",
  "packages/twin-linear/src/index.ts",
  "packages/twin-linear/src/domain/index.ts",
  "packages/twin-slack/src/index.ts",
  "packages/twin-slack/src/domain/index.ts",
  "packages/twin-stripe/src/index.ts",
  "packages/twin-stripe/src/domain/index.ts",
  "packages/adapter-claude-sdk/src/index.ts",
  "packages/wire/src/index.ts",
  "cli/src/contract/index.ts",
];

export default {
  name: "barrels",
  describe: "barrel indexes re-export only",
  check(ctx) {
    const violations = [];
    for (const rel of BARREL_PATHS) {
      // A listed barrel that no longer exists means this rule silently stopped
      // covering it, so it is a violation rather than a skip.
      if (!ctx.exists(rel)) {
        violations.push(`${rel}: listed as a barrel but absent — move this rule's entry with the file.`);
        continue;
      }
      for (const rawLine of ctx.readRel(rel).split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
        if (line.startsWith("export ")) continue;
        if (line.startsWith("} from ")) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*,?$/.test(line)) continue;
        if (line === "};" || line === "}") continue;
        violations.push(`${rel}: found logic/prose in a barrel: ${line}`);
      }
    }
    return { violations, summary: `${BARREL_PATHS.length} barrel(s) re-export only` };
  },
};
