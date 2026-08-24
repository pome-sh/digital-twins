#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table. The distinction worth pinning is the
// one the rule's header argues for: detection is by GYP MARKERS, not by
// `hasInstallScript`. Prebuilt-binary installers (esbuild, fsevents) have install
// scripts and need no compiler, so a rule keyed on install scripts would red on
// dependencies that must pass.
//
// Folded in from `cli/test/unit/no-native-modules.test.ts`, a vitest suite that
// asserted the same predicate from a third place.

import { defineCases } from "../harness.mjs";

const lock = (packages) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } });

const PROD = { version: "1.0.0" };

defineCases("no-native", [
  {
    name: "a pure-JS production closure passes",
    files: {
      "package-lock.json": lock({ "node_modules/pure": PROD }),
      "node_modules/pure/package.json": JSON.stringify({ name: "pure", version: "1.0.0" }),
    },
    expect: "green",
  },
  {
    name: "a binding.gyp in the production closure is a violation",
    files: {
      "package-lock.json": lock({ "node_modules/native": PROD }),
      "node_modules/native/package.json": JSON.stringify({ name: "native", version: "1.0.0" }),
      "node_modules/native/binding.gyp": "{}\n",
    },
    expect: "red",
    contains: ["node_modules/native", "binding.gyp"],
  },
  {
    name: 'a truthy "gypfile" manifest field is a violation',
    files: {
      "package-lock.json": lock({ "node_modules/native": PROD }),
      "node_modules/native/package.json": JSON.stringify({ name: "native", version: "1.0.0", gypfile: true }),
    },
    expect: "red",
    contains: '"gypfile": true',
  },
  {
    name: "a packaged .node binary with no binding.gyp is a violation too",
    files: {
      "package-lock.json": lock({ "node_modules/prebuilt": PROD }),
      "node_modules/prebuilt/package.json": JSON.stringify({ name: "prebuilt", version: "1.0.0" }),
      "node_modules/prebuilt/lib/addon.node": "binary\n",
    },
    expect: "red",
    contains: "packaged .node binary",
  },
  {
    // The whole reason detection is by gyp marker: esbuild and fsevents have
    // install scripts and need no compiler.
    name: "an install script alone is not a native build step",
    files: {
      "package-lock.json": lock({ "node_modules/prebuilt": { ...PROD, hasInstallScript: true } }),
      "node_modules/prebuilt/package.json": JSON.stringify({
        name: "prebuilt",
        version: "1.0.0",
        scripts: { postinstall: "node install.js" },
      }),
    },
    expect: "green",
  },
  {
    // `npm ci --omit=dev` never installs them and no published artifact carries
    // them.
    name: "a native dev dependency is out of the production closure",
    files: {
      "package-lock.json": lock({ "node_modules/native": { ...PROD, dev: true } }),
      "node_modules/native/package.json": JSON.stringify({ name: "native", version: "1.0.0" }),
      "node_modules/native/binding.gyp": "{}\n",
    },
    expect: "green",
  },
  {
    // A non-optional prod entry with nothing on disk means the scan cannot see
    // its markers, which must not read as a pass.
    name: "an uninstalled non-optional prod package is red, not skipped",
    files: { "package-lock.json": lock({ "node_modules/missing": PROD }) },
    expect: "red",
    contains: "cannot inspect",
  },
  {
    // Another OS's prebuilt-binary package. Nothing to inspect on this machine.
    name: "a platform-gated optional prod package not installed here is skipped, and said so",
    files: { "package-lock.json": lock({ "node_modules/darwin-only": { ...PROD, optional: true } }) },
    expect: "green",
    contains: "platform-gated optional packages not installed here",
  },
  {
    // A workspace symlink's own dependencies have their own lockfile entries, so
    // inspecting the link itself would double-count and would follow into a tree
    // this scan already covers.
    name: "a workspace link entry is not inspected",
    files: { "package-lock.json": lock({ "packages/twin-x": { link: true, resolved: "packages/twin-x" } }) },
    expect: "green",
  },
]);
