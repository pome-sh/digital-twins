// SPDX-License-Identifier: Apache-2.0
//
// A twin's declared check vocabulary must stay statically analysable; moving it
// behind `import()` relocates the cost rather than removing it.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { buildSpecifierMap, chainFor, reachable } from "../../lib/static-import-graph.mjs";

const CLI_ENTRY = "cli/src/cli/main.ts";

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
