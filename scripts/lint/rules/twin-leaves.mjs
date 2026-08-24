// SPDX-License-Identifier: Apache-2.0
//
// The rule that keeps the twin modules OTHER RUNTIMES import loadable by them.
//
// pome-cloud's `tools/fidelity-watch` runs under BUN, and several of its suites
// read declarations straight out of a pome-twins checkout — the stripe tool
// table for `isMutatingTool`, github's and slack's 501 envelopes, linear's
// GraphQL schema. Bun implements no `node:sqlite`. `packages/sdk/src/db.ts` opens
// with `import { DatabaseSync } from "node:sqlite"`, and the sdk's ROOT barrel
// re-exports `openTwinDatabase` from it — so one import of `@pome-sh/sdk` (rather
// than a leaf subpath) puts the whole engine's SQLite driver on the module-load
// path of a file whose own dependencies are zod and a JSON fixture.
//
// That is exactly what the fixture move did: every twin's tool table sits on a
// shared, dependency-free loader (`packages/sdk/src/mcp-tool-fixture.ts`, no
// imports at all) and each twin reached it through the barrel. The twins' own
// suites run on Node, where `node:sqlite` exists, so all of them stayed green;
// pome-cloud's daily fidelity-watch cron went red the next morning with
// `error: No such built-in module: node:sqlite`, in a repo the change had not
// touched.
//
// The rule is structural, so it cannot drift as twins grow:
//
//   No module in ENTRIES may statically reach a builtin that non-Node runtimes
//   do not implement. ENTRIES is every twin's MCP tool table (found by looking
//   for the fixture loader call, so a new twin is covered with no hand edit) plus
//   CROSS_RUNTIME_LEAVES, the named modules pome-cloud imports directly.
//
// A twin's SERVER is deliberately out of scope: `src/index.ts`, `src/db.ts` and
// `src/twin.ts` ARE the SQLite-backed engine, and nothing loads them anywhere but
// Node. This rule is about the declaration leaves, which have no business
// dragging a database driver behind them in any runtime.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildSpecifierMap, chainFor, reachable } from "../../lib/static-import-graph.mjs";

/**
 * Builtins a twin declaration leaf may not reach. Keyed by module specifier,
 * valued by the reason, which is printed on failure — a rule whose message does
 * not say which runtime broke gets "fixed" by adding an exception.
 */
const OFF_LIMITS_BUILTINS = new Map([
  ["node:sqlite", "bun implements no `node:sqlite`, and pome-cloud's fidelity-watch runs under bun"],
]);

/**
 * Twin modules pome-cloud imports directly, beyond the tool tables found below.
 * Taken from its real import sites (`tools/fidelity-watch`, via `twinModule()`);
 * pome-cloud's own `lint-twin-imports` gate is what keeps that list honest on its
 * side. A listed path that does not exist is a hard failure, not a skip — a stale
 * entry silently covering nothing is how this rule would stop working.
 */
const CROSS_RUNTIME_LEAVES = [
  // `sandboxes/stripe/level2.test.ts` — `isMutatingTool`.
  "packages/twin-stripe/src/tools.ts",
  // `lint-twin-namespace.test.ts` — the frozen 501 envelopes.
  "packages/twin-github/src/unsupported-envelope.ts",
  "packages/twin-slack/src/unsupported-envelope.ts",
  "packages/twin-stripe/src/errors.ts",
  // `twin-linear-schema.ts` — `linearGraphQLSchema`.
  "packages/twin-linear/src/graphql/schema.ts",
];

/** The fixture loader call. A module that makes it IS a twin's MCP tool table,
 *  whatever the file is named (`tools.ts` on github/slack/stripe, `mcp.ts` on
 *  gmail/linear). */
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

    // Each twin's tool-table module(s), discovered rather than listed.
    const toolTables = [];
    const twinsWithNoToolTable = [];
    for (const dir of twinDirs) {
      const found = ctx
        .files({ dirs: [`packages/${dir}/src`], ext: [".ts"], mustExist: false })
        .filter((file) => !file.endsWith(".d.ts") && readFileSync(file, "utf8").includes(TOOL_TABLE_MARKER));
      if (found.length === 0) twinsWithNoToolTable.push(dir);
      else toolTables.push(...found);
    }

    // The cheap way to pass a reachability rule is to remove the thing it walks.
    // Every first-party twin derives its tool table from a fixture; a twin that
    // no longer calls the loader has either regressed to a hand-written table or
    // renamed the loader, and either way this rule just stopped checking it.
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

    // Walked one entry at a time on purpose: a shared walk would report the chain
    // through whichever entry happened to reach the builtin first, and the useful
    // output here is "THIS module pome-cloud imports cannot load, by THIS route".
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
