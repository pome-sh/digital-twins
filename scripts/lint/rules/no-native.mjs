// SPDX-License-Identifier: Apache-2.0
//
// "Zero native deps" (M2) is an invariant, not an event: no package in the
// PRODUCTION dependency closure of the published packages may carry a node-gyp
// build step. Detection is by gyp markers — a `binding.gyp` file or a truthy
// `gypfile` manifest field — NOT by `hasInstallScript`: prebuilt-binary
// installers (esbuild, fsevents) have install scripts but need no compiler, and
// must pass.
//
// Scope is the lockfile's non-dev entries (workspace transitives included).
// `dev` and `devOptional` entries are excluded: they never reach a production
// install (`npm ci --omit=dev`) or a published artifact.
//
// Needs an installed `node_modules` — marker inspection needs the unpacked
// package on disk, so this rule is skipped by `--offline`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Intentional exceptions only; empty by design (same posture as the copy-marker
// rule's allowlist). Keys are lockfile package paths, e.g.
// "node_modules/some-package".
const ALLOWLIST = new Set([]);

export function findNativeModules(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const offenders = [];
  const skippedOptional = [];
  let checked = 0;

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue; // the root project itself
    if (entry.link) continue; // workspace symlink; its deps have own entries
    if (entry.dev || entry.devOptional) continue; // not in the prod closure
    if (ALLOWLIST.has(path)) continue;

    const pkgDir = join(root, path);
    if (!existsSync(pkgDir)) {
      if (entry.optional) {
        // Platform-gated optional prod dep not installed here (e.g. another
        // OS's prebuilt binary package). Nothing to inspect on this machine.
        skippedOptional.push(path);
        continue;
      }
      throw new Error(`cannot inspect "${path}" — directory missing. Run npm ci in ${root} first.`);
    }

    checked += 1;
    const markers = [];
    if (existsSync(join(pkgDir, "binding.gyp"))) markers.push("binding.gyp");
    try {
      if (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).gypfile) {
        markers.push('"gypfile": true');
      }
    } catch {
      // Unreadable manifest: the binding.gyp check above still applies.
    }
    // Packaged native addons sometimes ship prebuilt `.node` binaries without a
    // binding.gyp in the published tarball — treat those as native too.
    if (hasPackagedNodeBinary(pkgDir)) markers.push("packaged .node binary");
    if (markers.length > 0) offenders.push({ path, markers });
  }

  return { offenders, checked, skippedOptional };
}

/** Shallow walk: package root + one level of subdirs (covers common
 *  prebuild/lib layouts without scanning deep trees). */
function hasPackagedNodeBinary(pkgDir) {
  const stack = [pkgDir];
  let visited = 0;
  while (stack.length > 0 && visited < 64) {
    const dir = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isFile() && entry.name.endsWith(".node")) return true;
      if (entry.isDirectory() && dir === pkgDir) stack.push(join(dir, entry.name));
    }
  }
  return false;
}

export default {
  name: "no-native",
  describe: "no native build step in the production dependency closure",
  needsInstall: true,
  check(ctx) {
    const { offenders, checked, skippedOptional } = findNativeModules(ctx.root);
    return {
      violations: offenders.map(({ path, markers }) => `${path} (${markers.join(", ")})`),
      summary:
        `${checked} production packages clean` +
        (skippedOptional.length > 0
          ? ` (${skippedOptional.length} platform-gated optional packages not installed here, skipped)`
          : ""),
      hint:
        "Zero native deps is an M2 invariant: published packages must install with no compiler\n" +
        "toolchain. Replace the dependency or move it out of the production closure.",
    };
  },
};
