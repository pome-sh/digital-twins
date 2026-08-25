// SPDX-License-Identifier: Apache-2.0
//
// Shared traversal for rules. Fails on a missing scan root by default; opt out per
// call, with a reason, where the directory is genuinely optional.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const DEFAULT_SKIP_DIRS = ["node_modules", "dist", "build", ".git", "coverage"];

export function createContext({ root, verbose = false }) {
  const textCache = new Map();
  const walkCache = new Map();

  function read(abs) {
    let text = textCache.get(abs);
    if (text === undefined) {
      text = readFileSync(abs, "utf8");
      textCache.set(abs, text);
    }
    return text;
  }

  function files({ dirs, ext, skip = DEFAULT_SKIP_DIRS, mustExist = true }) {
    const key = JSON.stringify([dirs, ext, skip, mustExist]);
    const cached = walkCache.get(key);
    if (cached) return cached;

    const extensions = new Set(ext);
    const skipDirs = new Set(skip);
    const out = [];

    if (mustExist) {
      const missing = dirs.filter((dir) => {
        try {
          return !statSync(join(root, dir)).isDirectory();
        } catch {
          return true;
        }
      });
      if (missing.length > 0) {
        throw new Error(
          `scan director${missing.length === 1 ? "y" : "ies"} not found: ${missing.join(", ")}. ` +
            `A rule that cannot find what it was told to walk has stopped covering it — move the ` +
            `rule with the code, or drop the entry deliberately.`,
        );
      }
    }

    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return;
        throw err;
      }
      for (const entry of entries) {
        if (skipDirs.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        let stat;
        try {
          stat = statSync(abs);
        } catch (err) {
          if (err.code === "ENOENT") continue; // broken symlink
          throw err;
        }
        if (stat.isDirectory()) walk(abs);
        else if (stat.isFile() && matchesExt(entry.name, extensions)) out.push(abs);
      }
    };

    for (const dir of dirs) walk(join(root, dir));
    out.sort();
    walkCache.set(key, out);
    return out;
  }

  return {
    root,
    verbose,
    read,
    files,
    rel: (abs) => relative(root, abs).replaceAll("\\", "/"),
    abs: (relPath) => join(root, relPath),
    exists: (relPath) => existsSync(join(root, relPath)),
    readRel: (relPath) => read(join(root, relPath)),
    json: (relPath) => JSON.parse(read(join(root, relPath))),
  };
}

function matchesExt(name, extensions) {
  for (const ext of extensions) if (name.endsWith(ext)) return true;
  return false;
}
