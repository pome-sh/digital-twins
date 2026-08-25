// SPDX-License-Identifier: Apache-2.0
//
// Barrel and file-size ceilings. A missing scan root is RED, not an empty pass.

const FILE_SIZE_LIMIT = 500;
const FILE_SIZE_HEADER = /^\/\/\s*file-size:\s*.+/;

const ALLOWLIST = new Set([
  "cli/src/cli/main.ts",
  "cli/src/cli/eval.ts",
  "cli/src/cli/embedded-wiring.ts",
  "cli/src/cli/install.ts",
  "cli/src/hosted/client.ts",
  "cli/src/runner/runTaskHosted.ts",
  "packages/wire/src/otel/fixtures/data.ts",
  "packages/twin-github/src/serializers.ts",
  "packages/twin-github/src/tools.ts",
  "packages/twin-linear/src/seed.ts",
  "packages/twin-stripe/src/x402.ts",
]);

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

export default {
  name: "file-size",
  describe: `modules over ${FILE_SIZE_LIMIT} LOC state a reason or get split`,
  check(ctx) {
    const violations = [];
    for (const file of ctx.files({ dirs: SCAN_DIRS, ext: [".ts", ".tsx"] })) {
      const rel = ctx.rel(file);
      if (ALLOWLIST.has(rel)) continue;
      const lines = ctx.read(file).split("\n");
      if (lines.length <= FILE_SIZE_LIMIT) continue;
      if (FILE_SIZE_HEADER.test(lines[0] ?? "")) continue;
      violations.push(
        `${rel}: ${lines.length} lines exceeds ${FILE_SIZE_LIMIT} LOC — add a \`// file-size: <reason>\` header or split the module`,
      );
    }
    return { violations, summary: `${ALLOWLIST.size} allowlisted large module(s)` };
  },
};
