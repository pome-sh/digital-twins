// SPDX-License-Identifier: Apache-2.0
//
// No native addons in the published tree — they break the clean-room install.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
    }
    if (hasPackagedNodeBinary(pkgDir)) markers.push("packaged .node binary");
    if (markers.length > 0) offenders.push({ path, markers });
  }

  return { offenders, checked, skippedOptional };
}

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
