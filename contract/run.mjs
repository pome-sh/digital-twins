// SPDX-License-Identifier: Apache-2.0
//
// Orchestrator for the twin runtime-contract suite: build the wire
// contract + the five twins, then run the black-box suite with plain `node`.

import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// this runner exists to remove, promoted from one file to the whole suite. The
// argv/import.meta.url comparison the repo's other entry guards use, pinned
// for the same reason in scripts/capture-mcp-tools-list.test.mjs — but
// realpath'd on BOTH sides: node resolves symlinks before deriving
// `import.meta.url`, so a bare `path.resolve` of argv[1] misses through a
// symlinked checkout (`node /tmp/link/contract/run.mjs`) and skips silently in
// the same shape. Then, because any guard that can be wrong here is worth a
// crash rather than an exit 0: if we were invoked as this file and did NOT
// match, say so loudly instead of running nothing.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && path.basename(ENTRY) === path.basename(SELF)) {
  throw new Error(
    `contract/run.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having run nothing`
  );
}

if (invokedDirectly) {
  // Wire first: every twin's runtime import chain reaches it, and the suite spawns
  // the twins with plain `node`, so wire's dist/ must exist before anything boots.
  let status = run("npm", ["run", "build", "-w", "@pome-sh/wire"]);
  // The sdk build must precede the twin builds: twin-slack is a thin
  // @pome-sh/sdk plugin and compiles against the sdk dist.
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/sdk"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-github"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-slack"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-stripe"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-gmail"]);
  if (status === 0) status = run("npm", ["run", "build", "-w", "@pome-sh/twin-linear"]);
  if (status === 0) {
    const files = discoverTestFiles().map((f) => path.relative(REPO_ROOT, f));
    // Bare `node --test` with no paths recursively searches cwd — here the repo
    // root — so an empty discovery would silently turn "run the contract suite"
    // into "run every test in the monorepo". Say what actually happened.
    if (files.length === 0) throw new Error(`no *.test.mjs files discovered under ${CONTRACT_DIR}`);
    status = run("node", ["--test", ...files]);
  }

  process.exit(status);
}
