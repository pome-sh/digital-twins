// SPDX-License-Identifier: Apache-2.0
// Test helper. Tests invoke `runTask` under vitest, where `process.argv[1]` is
// vitest's worker entry — not pome's main — so the default child-process spawn.

import { createRequire } from "node:module";
import type { CaptureServerCommand } from "../../src/runner/runTask.js";
import { inCli } from "./cliDir.js";

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

export const captureServerForTests: CaptureServerCommand = {
  execPath: process.execPath,
  prefixArgs: ["--import", TSX_LOADER, inCli("src/cli/main.ts")],
};
