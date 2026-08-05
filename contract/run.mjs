// SPDX-License-Identifier: Apache-2.0
//
// Orchestrator for the twin runtime-contract suite (FDRS-711): build the wire
// contract + the five twins, then run the black-box suite with plain `node`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
  return res.status ?? 1;
}

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
  status = run("node", [
    "--test",
    "contract/contract.test.mjs",
    "contract/sdk-boot.test.mjs",
    "contract/gmail-fault.test.mjs",
  ]);

process.exit(status);
