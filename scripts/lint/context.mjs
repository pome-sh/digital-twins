// SPDX-License-Identifier: Apache-2.0
//
// The one tree walk, and the one file cache, that every lint rule shares.
//
// Every gate in the old fleet carried its own `walk()`: the same
// `readdirSync` recursion with its own idea of which directories to prune and
// which extensions to keep. Twenty-odd copies meant twenty-odd chances for one
// to quietly stop pruning `dist/` and start linting build output, or to keep
// pruning a directory the others had started covering.
//
// Reads are memoized because rules overlap: `legacy-markers` and `parent-vocab`
// both read every TypeScript file under `packages/`, and a rule that walks the
// same tree twice pays for it twice.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Pruned at ANY depth, in every walk, unless a rule overrides `skip`. */
export const DEFAULT_SKIP_DIRS = ["node_modules", "dist", "build", ".git", "coverage"];

/**
 * The handle a rule's `check()` receives. Everything a rule needs to read the
 * tree, and nothing that lets it decide how a violation is printed or what the
 * process exit code is — those belong to the runner.
 *
 * @param {{ root: string, verbose?: boolean }} options
 */
export function createContext({ root, verbose = false }) {
  const textCache = new Map();
  const walkCache = new Map();

  /** Absolute path → utf8 contents, read at most once per run. */
  function read(abs) {
    let text = textCache.get(abs);
    if (text === undefined) {
      text = readFileSync(abs, "utf8");
      textCache.set(abs, text);
    }
    return text;
  }

  /**
   * Every file under `dirs` (repo-root-relative) whose extension is in `ext`,
   * sorted, pruning `skip` at any depth. A directory that does not exist
   * contributes nothing — a rule that needs a floor on the count asserts it
   * itself, because "scanned nothing" and "found nothing wrong" print the same.
   *
   * `statSync` rather than the dirent: `isDirectory()`/`isFile()` are both
   * false for a symlink, so keying off the dirent silently skips a symlinked
   * script or subdirectory, and a skip reads as a pass.
   */
  function files({ dirs, ext, skip = DEFAULT_SKIP_DIRS }) {
    const key = JSON.stringify([dirs, ext, skip]);
    const cached = walkCache.get(key);
    if (cached) return cached;

    const extensions = new Set(ext);
    const skipDirs = new Set(skip);
    const out = [];

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
    /** Posix-normalized path relative to the repo root, for messages. */
    rel: (abs) => relative(root, abs).replaceAll("\\", "/"),
    abs: (relPath) => join(root, relPath),
    exists: (relPath) => existsSync(join(root, relPath)),
    /** Repo-root-relative read, for rules whose subject is one known file. */
    readRel: (relPath) => read(join(root, relPath)),
    json: (relPath) => JSON.parse(read(join(root, relPath))),
  };
}

function matchesExt(name, extensions) {
  for (const ext of extensions) if (name.endsWith(ext)) return true;
  return false;
}
