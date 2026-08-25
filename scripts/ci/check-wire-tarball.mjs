#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Release gate for @pome-sh/wire's own tarball.
//
// `scripts/clean-room-pack-test.mjs` audits the two npmjs tarballs — it asserts
// they carry NO `@pome-sh/*` dependency, which is the assertion that keeps wire
// inlined rather than installed. It says nothing about wire's own tarball,
// which reaches those users only as bytes inside the CLI's and the adapter's
// `dist/`.
//
// Now it is also published to GitHub Packages for cross-repo consumers
// (pome-cloud), and that install path has failure modes the workspace hides.
//
//   1. Inside this repo every consumer resolves `@pome-sh/wire` through npm's
//      workspace symlink to `packages/wire/`, where the whole source tree
//      exists, so an `exports` subpath pointing at a file the `files` field
//      does not ship resolves fine forever. A cross-repo consumer gets only
//      what is in the tarball, and the failure is
//      ERR_PACKAGE_PATH_NOT_EXPORTED on their first import — in their repo.
//   2. `npm publish` on a `private: true` workspace EXITS 0 with a warning
//      ("Skipping workspace …, marked as private"). A one-character regression
//      to `private: true` would therefore produce a fully green release that
//      published nothing — exactly the silence
//      the release apparatus exists to abolish.
//   3. Publishing to the wrong registry cannot be undone; public npm has no
//      unpublish window after 72 hours.
//
// Modes:
//   --manifest-only  Assert only the properties readable from package.json
//                    (private, publishConfig.registry). No build, no `npm
//                    pack`, no network — so ci.yml runs this on every PR, and
//                    2 and 3 above are caught BEFORE merge rather than by a
//                    red release job after the npmjs publishes already went out.
//   (default)        The above, plus pack wire and audit the real tarball.
//                    Requires a built `packages/wire/dist`.
//
// Usage: node scripts/ci/check-wire-tarball.mjs [--manifest-only] [--keep]

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

// ── Manifest assertions (no build, no network) ───────────────────────────────

// Stricter than npm, on purpose. npm publishes a manifest with no `private`
// field at all quite happily — but `private: true` makes `npm publish -w` exit
// 0 having published nothing, so the difference between "absent" and
// "explicitly false" is the difference between a silent regression and a loud
// one. Requiring `false` keeps the intent in the file where a reviewer sees it.
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

/** Every file path an `exports` map points at, conditions and subpaths flattened. */
function exportTargets(exportsField) {
  const targets = new Set();
  const walk = (node) => {
    if (typeof node === "string") targets.add(node.replace(/^\.\//, ""));
    else if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
  };
  walk(exportsField);
  return targets;
}

// `main`/`types` are the pre-`exports` resolution path; older tooling and
// bundlers still read them, so they have to ship too.
const declaredPaths = exportTargets(manifest.exports);
for (const field of ["main", "types"]) {
  if (typeof manifest[field] === "string") declaredPaths.add(manifest[field].replace(/^\.\//, ""));
}
declaredPaths.delete("package.json"); // always in the tarball; not a build output

// ── Tarball assertions ──────────────────────────────────────────────────────

function auditTarball() {
  const workDirectory = mkdtempSync(join(tmpdir(), "pome-wire-tarball-"));
  try {
    // --ignore-scripts: wire's `prepublishOnly` would rebuild, which would hide
    // a "published a stale dist" bug. The caller is expected to have built.
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

    // npm wraps every tarball entry in a top-level `package/` directory.
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

    // wire's tsconfig sets `sourceMap: true` and no `src/` ships, so every
    // emitted `.js.map` would be a dangling map with no `sourcesContent`.
    // `files` excludes them (`!dist/**/*.map`). clean-room-pack-test.mjs
    // already treats a dangling map in a published tarball as a hard failure
    // for the other two packages; wire holds to the same rule.
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
