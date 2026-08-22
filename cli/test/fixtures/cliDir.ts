// SPDX-License-Identifier: Apache-2.0
//
// Absolute paths inside the cli package, for tests that hand a path to
// `runTask` / `runDemo` or build a spawn command out of one.
//
// Those paths used to be written cwd-relative ("tasks/01-bug-happy-path.md",
// "node examples/agents/scripted-triage-agent.ts"), which worked only because
// vitest happened to run with cwd = cli/. vitest resolves `process.cwd()` to
// the directory of the CONFIG it loaded, not to a project's `root`, so with one
// root vitest.config.ts every project's tests run with cwd = the repo root and
// those literals resolve to paths that do not exist. Measured: 8 tests across 5
// files, all failing in `readFile`.
//
// A test that only passes when launched from one particular directory is the
// bug, not the config, so the paths are absolute here rather than the runner
// being pinned to a cwd.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The cli package root: this file is <cli>/test/fixtures/cliDir.ts. */
const CLI_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** An absolute path to `segments` under the cli package root. */
export const inCli = (...segments: string[]): string => join(CLI_DIR, ...segments);
