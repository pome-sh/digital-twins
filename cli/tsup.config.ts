// SPDX-License-Identifier: Apache-2.0
//
// The CLI ships as ONE self-contained bundle. Every `@pome-sh/*` workspace
// package (sdk, wire, the five twins) is inlined via `noExternal`, so
// the published tarball has zero internal runtime dependencies and none of the
// packages need to exist on npm. That replaces `bundleDependencies`, which
// silently stopped working once `cli/` joined the root npm workspace (npm packs
// bundled deps out of `cli/node_modules`, which npm now leaves empty).
//
// `splitting: true` + the per-entry `import()` calls in `src/twin/registry.ts`
// mean each twin lands in its own lazily-loaded chunk: `pome twin start github`
// never parses the other four twins or their SQLite schemas.
//
// Necessary but NOT sufficient: splitting can only
// defer what nothing on the startup path statically imports, and five modules
// under `src/task/` imported three twins' package roots for a zod seed schema.
// Both settings were doing their job and the claim was still false —
// `pome --version` loaded 1183.6 KB, of which 697.9 KB was three twin servers.
// `scripts/lint/rules/twin-chunks.mjs` asserts the graph these settings need.
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
// this whole restructure exists to remove. `scripts/lint/rules/bundled-deps.mjs`
// asserts every specifier the inlined packages import is declared here.
import { execSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const CLI_ROOT = new URL(".", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(resolve(CLI_ROOT, "package.json"), "utf8")) as {
  version: string;
  devDependencies?: Record<string, string>;
};

/**
 * `@pome-sh/*` devDependencies the CLI names for TYPES ONLY, which the map
 * below must not claim to have inlined.
 *
 * `@pome-sh/dashboard` is the render contract `cli/src/dashboard/` satisfies
 * (`packages/dashboard/src/api.ts`). Every reference to it is an `import type`,
 * so esbuild erases it and not one byte rides along — while the map's whole
 * purpose is to record "which vocabulary rode along" for `pome checks <twin>`
 * and the F-1791 digest-skew refusals. Listing a version for a package that is
 * not in the bundle is a false entry in a map those refusals trust.
 *
 * The dashboard's BUILD ordering does not come from this dependency either: it
 * falls out of `scripts/build.mjs`'s topological sort (dashboard depends only
 * on wire and lands in layer 1; the CLI lands in layer 3).
 */
const TYPE_ONLY_DEPS = new Set(["@pome-sh/dashboard"]);

/**
 * Versions of the `@pome-sh/*` packages this bundle inlines. They are
 * devDependencies resolved as workspace `"*"` links, so nothing in the
 * published tarball records which twin vocabulary rode along — except this
 * map, read by `src/cli/checks.ts`'s `pinnedVersion` for the
 * `pome checks <twin>` header and the digest-skew refusals (F-1791). Baked at
 * build time because build time is when the inlining happens.
 */
function inlinedPackageVersions(): Record<string, string> {
  const require = createRequire(resolve(CLI_ROOT, "package.json"));
  const inlined = Object.keys(pkg.devDependencies ?? {}).filter(
    (dep) => dep.startsWith("@pome-sh/") && !TYPE_ONLY_DEPS.has(dep),
  );
  return Object.fromEntries(
    inlined.map((dep) => {
      const manifest = JSON.parse(
        readFileSync(require.resolve(`${dep}/package.json`), "utf8"),
      ) as { version: string };
      return [dep, manifest.version];
    }),
  );
}

const BIN_ENTRY = resolve(CLI_ROOT, "dist/src/cli/main.js");

/**
 * The commit `pome init --example` fetches example files from. Same resolution
 * order as `scripts/write-build-info.mjs` (which stamps the identical SHA into
 * `dist/build-info.json`), so the tarball and the fetch agree by construction.
 *
 * Falls back to "" rather than "dev": `src/cli/init-example.ts` only accepts a
 * 40-hex value and uses `main` otherwise, and a contributor build with no `.git`
 * should scaffold from `main` rather than 404 on a ref named "dev".
 */
function resolveGitSha(): string {
  if (process.env.POME_GIT_SHA) return process.env.POME_GIT_SHA;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", {
      cwd: CLI_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * `npm pack` preserves file modes straight from disk and a global
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
    // Read by src/cli/init-example.ts: `pome init --example` fetches the
    // example as it stood at the commit that built THIS CLI, not as `main` has
    // it now. Without the pin an old CLI quietly scaffolds an example written
    // against a newer one.
    PKG_GIT_SHA: JSON.stringify(resolveGitSha()),
    // Read by src/cli/checks.ts. Double-stringified: define injects raw
    // source text, and the runtime wants a string literal holding JSON.
    POME_INLINED_PKG_VERSIONS: JSON.stringify(JSON.stringify(inlinedPackageVersions())),
    // Read by src/cli/usageTick.ts (F-1832). A PostHog project key is
    // write-only by design, so it is safe in a public binary; a build made
    // without these set sends nothing at all. The release workflow supplies
    // them from repository variables.
    POME_TELEMETRY_KEY: JSON.stringify(process.env.POME_TELEMETRY_KEY ?? ""),
    POME_TELEMETRY_HOST: JSON.stringify(process.env.POME_TELEMETRY_HOST ?? ""),
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
