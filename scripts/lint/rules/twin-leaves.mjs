// SPDX-License-Identifier: Apache-2.0
//
// Cross-runtime leaves must exist; one that does not is a comparison silently dropped.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildSpecifierMap, chainFor, reachable } from "../../lib/static-import-graph.mjs";

const OFF_LIMITS_BUILTINS = new Map([
  ["node:sqlite", "bun implements no `node:sqlite`, and pome-cloud's fidelity-watch runs under bun"],
]);

const CROSS_RUNTIME_LEAVES = [
  "packages/twin-stripe/src/tools.ts",
  "packages/twin-github/src/unsupported-envelope.ts",
  "packages/twin-slack/src/unsupported-envelope.ts",
  "packages/twin-stripe/src/errors.ts",
  "packages/twin-linear/src/graphql/schema.ts",
];

const TOOL_TABLE_MARKER = "loadMcpToolFixture(";

export default {
  name: "twin-leaves",
  describe: "no twin declaration leaf reaches a builtin other runtimes lack",
  check(ctx) {
    const packagesDir = ctx.abs("packages");
    const twinDirs = existsSync(packagesDir)
      ? readdirSync(packagesDir).filter(
          (dir) => dir.startsWith("twin-") && statSync(join(packagesDir, dir)).isDirectory(),
        )
      : [];
    if (twinDirs.length === 0) throw new Error(`No packages/twin-* found under ${ctx.root}.`);

    const toolTables = [];
    const twinsWithNoToolTable = [];
    for (const dir of twinDirs) {
      const found = ctx
        .files({ dirs: [`packages/${dir}/src`], ext: [".ts"], mustExist: false })
        .filter((file) => !file.endsWith(".d.ts") && readFileSync(file, "utf8").includes(TOOL_TABLE_MARKER));
      if (found.length === 0) twinsWithNoToolTable.push(dir);
      else toolTables.push(...found);
    }

    if (twinsWithNoToolTable.length > 0) {
      throw new Error(
        `${twinsWithNoToolTable.length} twin(s) have no module calling \`${TOOL_TABLE_MARKER}\`, so this ` +
          `rule covers no tool table for them: ${twinsWithNoToolTable.map((d) => `packages/${d}`).join(", ")}. ` +
          `Restore the loader call, or update TOOL_TABLE_MARKER if the loader was renamed.`,
      );
    }

    const missingLeaves = CROSS_RUNTIME_LEAVES.filter((path) => !ctx.exists(path));
    if (missingLeaves.length > 0) {
      throw new Error(
        `${missingLeaves.length} entry in CROSS_RUNTIME_LEAVES does not exist, so it covers nothing: ` +
          `${missingLeaves.join(", ")}. pome-cloud imports these modules by path from a pome-twins ` +
          `checkout — if one moved, pome-cloud's import is already broken; fix the path here and there together.`,
      );
    }

    const entries = [...new Set([...toolTables, ...CROSS_RUNTIME_LEAVES.map((path) => ctx.abs(path))])];
    const specifiers = buildSpecifierMap(ctx.root);
    const violations = [];

    for (const entry of entries) {
      const { importedBy, external } = reachable([entry], specifiers);
      for (const edge of external) {
        const reason = OFF_LIMITS_BUILTINS.get(edge.specifier);
        if (!reason) continue;
        const chain = [...chainFor(edge.from, importedBy, ctx.rel), edge.specifier];
        violations.push(
          `${ctx.rel(entry)} — reaches ${edge.specifier}\n  ${reason}\n` +
            chain.map((step, index) => `  ${index === 0 ? "" : "-> "}${step}`).join("\n"),
        );
      }
    }

    return {
      violations,
      summary: `${entries.length} cross-runtime twin module(s) across ${twinDirs.length} twins, none reaching ${[...OFF_LIMITS_BUILTINS.keys()].join(", ")}`,
      detail: entries.map(ctx.rel),
      hint:
        "The usual cause is an import of the `@pome-sh/sdk` ROOT barrel for a value a leaf subpath\n" +
        "already exports: the barrel re-exports `openTwinDatabase`, which is `node:sqlite`. Import\n" +
        "the leaf instead — `@pome-sh/sdk/mcp-tool-fixture` for the tool-table loader,\n" +
        "`@pome-sh/sdk/db` for the database types. Types are free either way: `import type` is\n" +
        "erased and this rule ignores it.",
    };
  },
};
