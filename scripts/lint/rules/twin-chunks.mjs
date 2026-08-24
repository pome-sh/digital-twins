// SPDX-License-Identifier: Apache-2.0
//
// The rule that makes "each twin is a lazily-loaded chunk" a fact rather than a
// comment.
//
// `cli/tsup.config.ts` and `cli/src/twin/registry.ts` both claim it, and
// CHANGELOG 0.21.0 shipped it as a headline. It was false for three of the five
// twins for five releases: five modules under `cli/src/task/` top-level-imported
// the PACKAGE ROOT of twin-github/gmail/linear to reach a zod seed schema, and
// each of those roots also exports the twin's domain, its SQLite schema and its
// Hono app — so `pome --version` parsed ~600 KB of three twins' servers. Nothing
// failed; the claim just stopped being true, quietly, and was found by an audit
// rather than by CI.
//
// The rule is structural, so it cannot drift as twins grow:
//
//   The CLI's STATIC import graph must not reach any twin's package root
//   (`src/index.ts`), its database module (`src/db.ts`), or anything under
//   `src/domain/`. A twin's domain is reached through `import()` inside
//   `TWIN_REGISTRY`'s own methods — nowhere else.
//
// and the complement is asserted too, because the cheap way to pass a laziness
// rule is to break a command:
//
//   Every twin's `src/checks.ts` MUST stay statically reachable. `pome checks`
//   lists, looks up and digests the declared vocabulary synchronously; deferring
//   it behind `import()` would move the cost, not remove it, and would turn
//   `findCheck`/`twinOf` async for no gain.
//
// Dependency-free and build-free on purpose: it reads TypeScript sources and the
// twins' real `exports` maps, so it runs before `npm ci` and cannot disagree with
// the bundler about which subpath resolves where.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// The import lexer and the graph walk are shared with `twin-leaves` and
// `route-inputs` — rules asking reachability questions about the same graph must
// not hold two opinions about what a type-only import is.
import { buildSpecifierMap, chainFor, reachable } from "../../lib/static-import-graph.mjs";

const CLI_ENTRY = "cli/src/cli/main.ts";

/** Reaching any of these means the twin's whole server came along: `index.ts` is
 *  the barrel that exports it, `db.ts` is the SQLite schema, `domain/` is the
 *  state machine. Every other twin module worth deferring hangs off one of them. */
function domainViolation(rel, twinDirs) {
  for (const dir of twinDirs) {
    const prefix = `packages/${dir}/`;
    if (!rel.startsWith(prefix)) continue;
    const inside = rel.slice(prefix.length);
    if (inside === "src/index.ts") {
      return { twin: dir, what: "package root (exports the domain and the Hono app)" };
    }
    if (inside === "src/db.ts") return { twin: dir, what: "SQLite schema" };
    if (inside.startsWith("src/domain/")) return { twin: dir, what: "domain" };
  }
  return null;
}

export default {
  name: "twin-chunks",
  describe: "no twin domain/db/package-root edge in the CLI's static import graph",
  check(ctx) {
    const packagesDir = ctx.abs("packages");
    const twinDirs = existsSync(packagesDir)
      ? readdirSync(packagesDir).filter((dir) => dir.startsWith("twin-"))
      : [];

    // A rule that silently passes on an empty tree reads as coverage it does not
    // have.
    if (twinDirs.length === 0) throw new Error(`No packages/twin-* found under ${ctx.root}.`);
    if (!ctx.exists(CLI_ENTRY)) throw new Error(`CLI entry not found: ${CLI_ENTRY}.`);

    const { importedBy } = reachable([ctx.abs(CLI_ENTRY)], buildSpecifierMap(ctx.root));
    const violations = [];

    for (const file of importedBy.keys()) {
      const hit = domainViolation(ctx.rel(file), twinDirs);
      if (!hit) continue;
      const chain = chainFor(file, importedBy, (path) => relative(ctx.root, path));
      violations.push(
        `${ctx.rel(file)} — ${hit.twin}'s ${hit.what}; statically reachable from ${CLI_ENTRY}, so it ` +
          `loads on every \`pome\` invocation:\n` +
          chain.map((step, index) => `  ${index === 0 ? "" : "-> "}${step}`).join("\n"),
      );
    }

    // The cheap way to pass a laziness rule is to break `pome checks`.
    for (const dir of twinDirs) {
      const checks = join(packagesDir, dir, "src/checks.ts");
      if (!existsSync(checks) || importedBy.has(checks)) continue;
      violations.push(
        `${ctx.rel(checks)}: this twin's declared check vocabulary is NO LONGER statically ` +
          `reachable. \`pome checks\` lists, looks up and digests it synchronously; deferring it ` +
          `behind \`import()\` moves the cost instead of removing it and makes ` +
          `\`findCheck\`/\`twinOf\`/\`localDigest\` async for no gain.`,
      );
    }

    return {
      violations,
      summary: `${twinDirs.length} twins, ${importedBy.size} files in the CLI's static graph`,
      detail: perPackageCounts(importedBy, ctx),
      hint:
        "Reach a twin's domain through `import()` inside its `TWIN_REGISTRY` entry\n" +
        "(cli/src/twin/registry.ts). If all you need is a seed schema or a default world, import\n" +
        "the twin's `/seed` subpath — it is a zod-only leaf.",
    };
  },
};

function perPackageCounts(importedBy, ctx) {
  const perPackage = new Map();
  for (const file of importedBy.keys()) {
    const rel = ctx.rel(file);
    const key = rel.startsWith("packages/") ? rel.split("/").slice(0, 2).join("/") : "cli";
    perPackage.set(key, (perPackage.get(key) ?? 0) + 1);
  }
  return [...perPackage]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${String(count).padStart(4)}  ${key}`);
}
