// SPDX-License-Identifier: Apache-2.0
//
// Orchestrator for the twin runtime-contract suite (FDRS-711): build the wire
// contract + the five twins, then run the black-box suite with plain `node`.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_DIR = path.dirname(fileURLToPath(import.meta.url));

// cli-start.test.mjs boots the CLI's own compiled entry
// (cli/dist/src/cli/main.js). cli/ is a workspace this script never builds
// (only wire/sdk/twin-* above), so the file can't run here without a build
// step this runner doesn't own — ci.yml builds the CLI and runs it as its own
// step (see the prerequisite note atop contract/cli-start.test.mjs). This is
// the one deliberate exclusion from discovery, not a second hand-list.
const EXCLUDED_FROM_DISCOVERY = new Set(["cli-start.test.mjs"]);

/** Every *.test.mjs file directly under `dir`, sorted, minus `excluded` names. */
export function discoverTestFiles(dir = CONTRACT_DIR, excluded = EXCLUDED_FROM_DISCOVERY) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs") && !excluded.has(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
  return res.status ?? 1;
}

// Guarded so run.test.mjs can import discoverTestFiles() without re-triggering
// the build + spawn pipeline below (that recursion is how a plain `import`
// used to shell out to npm build and re-run `node --test` on itself).
//
// NOT `import.meta.main`: that landed in Node 24.2 and root `engines` allows
// `>=24`, so on 24.0/24.1 it is `undefined`, this guard is false, and
// `npm run test:contract` exits 0 having built nothing and asserted nothing —
// the exact "a check that never ran reads like one that passed" failure
// F-1353 exists to remove, promoted from one file to the whole suite. Same
// argv/import.meta.url comparison the repo's other entry guards use, pinned
// for the same reason in scripts/capture-mcp-tools-list.test.mjs.
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  // Wire first: every twin's runtime import chain reaches it, and the suite spawns
  // the twins with plain `node`, so wire's dist/ must exist before anything boots.
  let status = run("npm", ["run", "build", "-w", "@pome-sh/wire"]);
  // The sdk build must precede the twin builds: twin-slack is a thin
  // @pome-sh/sdk plugin since F-683 and compiles against the sdk dist.
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/sdk"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-github"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-slack"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-stripe"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-gmail"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-linear"]);
  if (status === 0)
    status = run("node", ["--test", ...discoverTestFiles().map((f) => path.relative(REPO_ROOT, f))]);

  process.exit(status);
}
