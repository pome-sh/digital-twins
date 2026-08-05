// SPDX-License-Identifier: Apache-2.0
//
// Runtime asset resolution for the bundled CLI.
//
// Non-code files the CLI reads at runtime (the fix-prompt system prompt, the
// packaged demo task markdown + seed sidecar) used to live next to their
// importing module under `src/`, resolved with
// `dirname(fileURLToPath(import.meta.url))` and copied into the mirrored
// `dist/src/...` tree at build time. That breaks under bundling: the importing
// module no longer has its own file. With code splitting, `fix-prompt/prompt.ts`
// may be inlined into `dist/src/cli/main.js` or into a shared
// `dist/chunk-*.js`, so `import.meta.url` points at a directory that depends on
// how esbuild happened to split the graph — and the asset is not there either
// way. The symptom is ENOENT at startup, since the fix-prompt system prompt is
// read at module scope.
//
// Assets now live at `<packageRoot>/assets/**` in EVERY layout — dev tree,
// bundled dist, and published tarball — resolved through `resolvePackageRoot`,
// which walks up to the nearest enclosing package.json and therefore does not
// care where inside `dist/` the caller ended up. Same convention the CLI already
// uses for its package-root `tasks/` and `examples/agents/` payloads.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "./resolve-package-root.js";

/**
 * Absolute path to a packaged asset, e.g.
 * `assetPath("demo", "first-run-demo.md")`.
 *
 * Throws rather than returning a maybe-path: every caller needs the file, and a
 * missing asset is a packaging bug that must fail loudly at the point of use
 * instead of surfacing as a confusing ENOENT further down.
 */
export function assetPath(...segments: string[]): string {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) {
    throw new Error(
      "Could not locate the @pome-sh/cli package root (no enclosing package.json) " +
        `while resolving the packaged asset ${segments.join("/")}.`,
    );
  }
  const candidate = join(root, "assets", ...segments);
  if (!existsSync(candidate)) {
    throw new Error(
      `Packaged asset not found at ${candidate}. This is a packaging bug — ` +
        "`assets/` must be listed in cli/package.json `files`.",
    );
  }
  return candidate;
}
