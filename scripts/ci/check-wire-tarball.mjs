#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Release gate for @pome-sh/wire's own tarball. Both ways it silently stops
// publishing are readable from package.json: `private: true` exits 0 having
// skipped it, and a wrong `publishConfig.registry` cannot be undone.
//
// The full mode also packs and resolves every `exports` subpath — inside this
// repo the workspace symlink makes a broken one resolve forever.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEEP = process.argv.includes("--keep");
const MANIFEST_ONLY = process.argv.includes("--manifest-only");
const MANIFEST_PATH = join(ROOT, "packages", "wire", "package.json");
const EXPECTED_REGISTRY = "https://npm.pkg.github.com";

const failures = [];
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

if (manifest.private !== false) {
  failures.push(
    `packages/wire/package.json has \`private: ${JSON.stringify(manifest.private)}\`; it must be exactly \`false\`.\n` +
      "    `private: true` is worse than a publish failure: `npm publish -w` skips a private\n" +
      "    workspace with a warning and EXITS 0, so the release goes green having published\n" +
      "    nothing. An absent field would publish, but states nothing to a reviewer.",
  );
}

if (manifest.publishConfig?.registry !== EXPECTED_REGISTRY) {
  failures.push(
    `packages/wire/package.json \`publishConfig.registry\` must be ${EXPECTED_REGISTRY} — ` +
      `found ${JSON.stringify(manifest.publishConfig?.registry)}.\n` +
      "    wire is internal infrastructure for cross-repo consumers, not an end-user package.\n" +
      "    A mistaken publish to registry.npmjs.org cannot be taken back after 72 hours.",
  );
}

function exportTargets(exportsField) {
  const targets = new Set();
  const walk = (node) => {
    if (typeof node === "string") targets.add(node.replace(/^\.\//, ""));
    else if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
  };
  walk(exportsField);
  return targets;
}

const declaredPaths = exportTargets(manifest.exports);
for (const field of ["main", "types"]) {
  if (typeof manifest[field] === "string") declaredPaths.add(manifest[field].replace(/^\.\//, ""));
}
declaredPaths.delete("package.json"); // always in the tarball; not a build output

function auditTarball() {
  const workDirectory = mkdtempSync(join(tmpdir(), "pome-wire-tarball-"));
  try {
    execFileSync(
      "npm",
      ["pack", "-w", "@pome-sh/wire", "--ignore-scripts", "--pack-destination", workDirectory],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const tarballName = readdirSync(workDirectory).find((file) => file.endsWith(".tgz"));
    if (!tarballName) {
      failures.push("`npm pack -w @pome-sh/wire` produced no tarball");
      return;
    }
    const tarball = join(workDirectory, tarballName);
    console.log(`packed ${tarballName}`);

    const hardLinks = execFileSync("tar", ["-tvf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("h"));
    if (hardLinks.length > 0) {
      failures.push(
        `tarball contains hard links — the registry rejects these (E415):\n${hardLinks.join("\n")}`,
      );
    }

    const shipped = new Set(
      execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim().replace(/^package\//, ""))
        .filter(Boolean),
    );

    const missing = [...declaredPaths].filter((path) => !shipped.has(path));
    if (missing.length > 0) {
      failures.push(
        "these paths are declared in packages/wire/package.json (`exports`/`main`/`types`) but are\n" +
          "    NOT in the tarball, so a cross-repo consumer's import dies with\n" +
          "    ERR_PACKAGE_PATH_NOT_EXPORTED:\n" +
          missing.map((path) => `      - ${path}`).join("\n") +
          "\n    Fix: add the file's directory to the `files` field, or drop the export.",
      );
    }

    const sourcemaps = [...shipped].filter((path) => path.endsWith(".map"));
    if (sourcemaps.length > 0) {
      failures.push(
        `tarball contains ${sourcemaps.length} dangling sourcemap(s) — no \`src/\` ships, so they\n` +
          "    resolve to nothing for a consumer. `files` should keep excluding `!dist/**/*.map`:\n" +
          sourcemaps.map((path) => `      - ${path}`).join("\n"),
      );
    }

    console.log(
      `  ✓ ${declaredPaths.size} declared path(s) ship, no hard links, no dangling sourcemaps`,
    );
  } finally {
    if (KEEP) console.log(`--keep: left the packed tarball at ${workDirectory}`);
    else rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (!MANIFEST_ONLY) auditTarball();

if (failures.length > 0) {
  console.error(
    `\n@pome-sh/wire ${MANIFEST_ONLY ? "manifest" : "tarball"} audit FAILED:`,
  );
  for (const failure of failures) console.error(`\n  - ${failure}`);
  process.exit(1);
}

console.log(
  MANIFEST_ONLY
    ? `@pome-sh/wire manifest audit passed — private: false, publishConfig targets ${EXPECTED_REGISTRY}.`
    : `@pome-sh/wire tarball audit passed — publishConfig targets ${EXPECTED_REGISTRY}, tarball is consumable.`,
);
