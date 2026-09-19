// SPDX-License-Identifier: Apache-2.0
//
// The arguments that make `node` itself run a TypeScript entry:
// `spawn(process.execPath, [...tsxNodeArgs(import.meta.url), entry, ...args])`.
//
// Use this, not the `tsx` executable, for any process a test will signal. The
// tsx CLI is a second process between the test and the program: it forwards
// SIGINT and SIGTERM, but nothing can forward SIGKILL, so killing it orphans
// the program underneath. A `pome twin start` orphaned that way kept its ports
// open indefinitely — every full local run of the cli project left seven
// behind — while a program with nothing else holding its event loop open exits
// by itself once the wrapper's pipe closes, so a SIGKILL sent through the
// wrapper never reaches the program at all.
//
// `captureServerForTests.ts` beside this already spawns the CLI the same way.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export function tsxNodeArgs(fromUrl: string): string[] {
  return ["--import", pathToFileURL(createRequire(fromUrl).resolve("tsx")).href];
}
