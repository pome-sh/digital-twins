// SPDX-License-Identifier: Apache-2.0
//
// Absolute paths inside the cli package, for tests that hand a path to
// `runTask` / `runDemo` or build a spawn command out of one.
//
// They are absolute because a cwd-relative literal ("tasks/01-bug-happy-path.md")
// only resolves when vitest runs with cwd = cli/. vitest sets `process.cwd()` to
// the directory of the CONFIG it loaded, not to a project's `root`, so under one
// root vitest.config.ts every project's tests run with cwd = the repo root and
// such literals point at paths that do not exist.
//
// A test that only passes when launched from one particular directory is the bug,
// not the config, so the paths are absolute here rather than the runner being
// pinned to a cwd.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The cli package root: this file is <cli>/test/fixtures/cliDir.ts. */
const CLI_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** An absolute path to `segments` under the cli package root. */
export const inCli = (...segments: string[]): string => join(CLI_DIR, ...segments);
