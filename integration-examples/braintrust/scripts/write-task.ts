// SPDX-License-Identifier: Apache-2.0
//
// Regenerate the committed task file. `test/task.test.ts` pins
// `tasks/lost-response-double-refund.md` to `renderTask(WORLDS[0])`, so the
// answer to that test going red is `npm run task:write`, not a hand edit.
//
// It lives here rather than in `src/` because it is not part of the example a
// reader is meant to study — it is the one-line generator behind an artifact
// they are.

import { realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WORLDS } from "../src/dataset.js";
import { COMMITTED_TASK_PATH, renderTask } from "../src/task.js";

export function writeCommittedTask(packageRoot: string): string {
  const path = resolve(packageRoot, COMMITTED_TASK_PATH);
  writeFileSync(path, renderTask(WORLDS[0]!), "utf8");
  return path;
}

// NOT `import.meta.main`: it landed in Node 24.2 and this package's `engines`
// allows `>=24`, so on 24.0/24.1 it is `undefined`, the guard is false, and the
// script prints nothing and exits 0 having written nothing. Realpath'd on BOTH
// sides because node resolves symlinks before deriving `import.meta.url`, so a
// bare resolve of argv[1] misses through a symlinked checkout in the same
// silent shape.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";

if (ENTRY === SELF) {
  console.log(`wrote ${writeCommittedTask(resolve(dirname(SELF), ".."))}`);
}
