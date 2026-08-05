// SPDX-License-Identifier: Apache-2.0
//
// Resolve the `tsx` executable without assuming where npm installed it.
// Before `cli/` joined the root npm workspace, tsx always landed in
// `cli/node_modules/.bin/tsx`; npm now hoists it to the workspace root, so a
// fixed path is wrong in one layout or the other. Resolve the package from the
// caller's module graph and read tsx's own `bin` entry instead.
//
// Test/script-only: `cli/scripts/**` is outside tsconfig.build.json, so this
// never ships in the published tarball.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export function resolveTsxBin(fromUrl: string): string {
  const manifestPath = createRequire(fromUrl).resolve("tsx/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsx;
  if (!entry) {
    throw new Error(`tsx manifest at ${manifestPath} declares no "tsx" bin entry`);
  }
  return resolve(dirname(manifestPath), entry);
}
