// SPDX-License-Identifier: Apache-2.0
//
// The CLI ships as ONE self-contained bundle. Every `@pome-sh/*` workspace
// package (sdk, shared-types, the five twins) is inlined via `noExternal`, so
// the published tarball has zero internal runtime dependencies and none of the
// packages need to exist on npm. That replaces `bundleDependencies`, which
// silently stopped working once `cli/` joined the root npm workspace (npm packs
// bundled deps out of `cli/node_modules`, which npm now leaves empty).
//
// `splitting: true` + the per-entry `import()` calls in `src/twin/registry.ts`
// mean each twin lands in its own lazily-loaded chunk: `pome twin start github`
// never parses the other four twins or their SQLite schemas.
//
// Entry name is `src/cli/main` rather than the default `main` deliberately —
// `dist/src/cli/main.js` is the `bin` target, the path `contract/cli-start.test.mjs`
// spawns, and the path quickstart-smoke runs. Keeping it identical means no
// frozen surface moves in this PR.
//
// Third-party deps stay EXTERNAL and remain real `dependencies`: the AI SDK
// providers, `ai`, `commander`, `hono`, `zod`, `graphql`, `yaml`,
// `@hono/node-server`, `@anthropic-ai/sdk`. Bundling them would fight their own
// conditional exports and duplicate zod's schema identity — which is the bug
// this whole restructure exists to remove. `scripts/check-bundled-runtime-deps.mjs`
// asserts every specifier the inlined packages import is declared here.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const CLI_ROOT = new URL(".", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(resolve(CLI_ROOT, "package.json"), "utf8")) as {
  version: string;
};

const BIN_ENTRY = resolve(CLI_ROOT, "dist/src/cli/main.js");

/**
 * FDRS-666 — `npm pack` preserves file modes straight from disk and a global
 * install's `pome` symlink points at this file, so a 644 bin means `pome` is
 * not found on PATH until the user chmods it by hand. tsup already adds the
 * shebang and the exec bit for entries named in `bin`; assert both rather than
 * trust it, since the failure is invisible to every test that execs via `node`.
 * `cli/test/unit/bin-exec-bit.test.ts` is the standing guard.
 */
function ensureExecutableBin() {
  const contents = readFileSync(BIN_ENTRY, "utf8");
  if (!contents.startsWith("#!")) {
    writeFileSync(BIN_ENTRY, `#!/usr/bin/env node\n${contents}`);
  }
  chmodSync(BIN_ENTRY, 0o755);
}

export default defineConfig({
  entry: { "src/cli/main": "src/cli/main.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  // The CLI is an application, not a library: no consumer imports its types.
  dts: false,
  clean: true,
  splitting: true,
  sourcemap: false,
  treeshake: true,
  noExternal: [/^@pome-sh\//],
  // tsup 8 strips the `node:` prefix from builtin imports by default (a
  // legacy-bundler compatibility default, flipped in tsup 9). That turns the
  // sdk's `import { DatabaseSync } from "node:sqlite"` into a bare `"sqlite"`
  // import, and every twin chunk dies with `Cannot find package 'sqlite'` —
  // there is no `sqlite` package. Keep the prefixes.
  removeNodeProtocol: false,
  define: {
    // Read by src/cli/main.ts for `pome --version`. Baked in so the published
    // CLI never has to locate its own package.json at runtime.
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  async onSuccess() {
    ensureExecutableBin();
    // Runtime assets are NOT copied into dist: they live at
    // `<packageRoot>/assets/**` and ship via cli/package.json `files`.
    // See src/cli/assets.ts for why.
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [resolve(CLI_ROOT, "scripts/write-build-info.mjs")], {
      stdio: "inherit",
    });
  },
});
