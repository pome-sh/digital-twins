// SPDX-License-Identifier: Apache-2.0
// `npm pack` preserves file modes straight from disk, and a global install's `pome`
// bin symlink points at dist/src/cli/main.js.

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/src/cli/main.js",
);

describe("published bin exec bit", () => {
  // File modes are a POSIX concept and the publish packs on POSIX CI; skip
  // on Windows and on local checkouts that haven't built dist/ yet.
  it.skipIf(process.platform === "win32" || !existsSync(BIN))(
    "dist/src/cli/main.js carries the executable bit after build",
    () => {
      const mode = statSync(BIN).mode;
      expect(
        mode & 0o111,
        `dist/src/cli/main.js mode is 0${(mode & 0o777).toString(8)} — the build script's chmod is gone`,
      ).not.toBe(0);
    },
  );
});
