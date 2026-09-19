// SPDX-License-Identifier: Apache-2.0
//
// The dashboard builds straight into `cli/assets/dashboard/`, the directory
// `cli/package.json` already ships via `files: ["assets"]` and `assetPath()`
// already resolves in all three layouts (dev tree, bundled dist, published
// tarball). There is no copy step: a copy would need its own script, and
// `scripts/check-packages-scripts-wired.mjs` would then want an exemption for
// a script only tsup calls. One pipeline, no exemption.
//
// Build ORDER comes free from `scripts/build.mjs`'s topological sort: this
// package depends on `@pome-sh/wire` and nothing else, so it lands in layer 1,
// while `@pome-sh/cli` (which depends on wire, sdk and all five twins) lands in
// layer 3. The CLI is therefore always built after the assets it ships exist.
// Deliberately NO `@pome-sh/dashboard` entry in the CLI's dependencies for
// ordering — that would put a version for a package the CLI does not inline
// into `POME_INLINED_PKG_VERSIONS`, which feeds `pome checks <twin>`'s header.
//
// Filenames are unhashed on purpose. The loopback server serves three files by
// exact name and never walks the directory, so there is no path-traversal
// surface on a port any process on the machine can reach. Hashing would force
// a directory read to discover the names.
//
// Fonts are inlined into `app.css` as data URIs rather than emitted as files, for
// the same reason: the three-file list stays the whole of what the server knows.
// Only the latin subsets ship (`src/fonts.css`) — Geist, Geist Mono and Source
// Serif 4 together are ~100 KB of woff2, where every subset fontsource carries
// would be over a megabyte in a tarball `npx` downloads.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const OUT_DIR = fileURLToPath(new URL("../../cli/assets/dashboard", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Above the largest font (Source Serif 4, ~51 KB), so every one inlines.
    assetsInlineLimit: 64 * 1024,
    outDir: OUT_DIR,
    emptyOutDir: true,
    // One CSS file, not one per chunk: the server serves a fixed file list.
    cssCodeSplit: false,
    // No sourcemaps in the published tarball — the page is a view, not a
    // debugging target, and they would be the largest thing `files` ships.
    sourcemap: false,
    // Fixed names, no hashes: the loopback server serves three files by exact
    // name and never reads the directory, so there is no traversal surface on a
    // port every process on the machine can reach. Nothing here imports
    // dynamically, so one entry is one chunk without asking for it.
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
