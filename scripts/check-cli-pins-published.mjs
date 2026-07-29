#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1135 — release-time check that every `@pome-sh/*` version `cli/package.json`
// pins actually exists on npm, read FROM THE MANIFEST.
//
// What this replaces: `cli-release.yml` used to `npm view` seven hard-coded
// version literals. That set was the true pin set on 2026-07-20 (`6454466`);
// the pins moved six times afterwards and the literals never followed, so by
// 2026-07-29 all seven resolved against versions nobody shipped and the step
// could not fail. `07f3b9c` even edited the block to add twin-linear without
// touching the six stale lines above it. It was not a hole — a bogus pin still
// breaks the later `npm ci` — but it read like something was watching when
// nothing was. Deriving the list from the manifest is the whole point: there is
// no second copy of the versions to go stale.
//
// Why a pin can be missing from npm, and why the two cases differ:
//
//   PENDING — the pin equals its `packages/*` version and that version has not
//     published yet. This is the designed ordering: the packages-v* batch
//     publishes first, then the CLI release runs. Sets `ready=false` so
//     `cli-release.yml` skips; hard-failing would block every release whose
//     batch lags.
//   BOGUS — the pin is missing AND disagrees with the workspace (or names a
//     package this repo does not build). No batch will ever publish it, so
//     waiting is the wrong answer. Exit 1 and name it.
//
// Anything that is not a clean E404 — a network blip, a registry 5xx — exits 2.
// Reading that as "not published yet" would silently skip a release.
//
// Usage: node scripts/check-cli-pins-published.mjs [repo root]
//   Writes `ready=true|false` to $GITHUB_OUTPUT when that is set.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readPins, readWorkspace } from "./check-cli-pins-match-workspace.mjs";

const SCOPE = "@pome-sh/";

/** @returns {"published" | "missing"} — throws if the registry answered anything else. */
function probe(spec) {
  try {
    execFileSync("npm", ["view", spec, "version"], { encoding: "utf8", stdio: "pipe" });
    return "published";
  } catch (err) {
    const stderr = String(err.stderr ?? "");
    if (stderr.includes("E404") || stderr.includes("404 Not Found")) return "missing";
    throw new Error(`npm view ${spec} failed without E404:\n${stderr.trim() || err.message}`);
  }
}

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const pins = readPins(root);
  const workspace = readWorkspace(root);

  const pending = [];
  const bogus = [];
  let checked = 0;

  for (const [name, pin] of Object.entries(pins)) {
    // Third-party deps are npm's problem; probing them would make the release
    // wait on unrelated registry state.
    if (!name.startsWith(SCOPE)) continue;
    const spec = `${name}@${pin}`;
    checked++;

    let state;
    try {
      state = probe(spec);
    } catch (err) {
      console.error(`❌ Refusing to certify the release: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    if (state === "published") continue;

    const workspaceVersion = workspace[name.slice(SCOPE.length)];
    if (workspaceVersion === pin) pending.push({ spec, workspaceVersion });
    else bogus.push({ spec, pin, workspaceVersion });
  }

  if (bogus.length > 0) {
    const lines = bogus.map(
      ({ spec, workspaceVersion }) =>
        `  ${spec}  ← not on npm\n      packages/ has: ${workspaceVersion ?? "(no such package in this repo)"}`,
    );
    console.error(`❌ CLI release blocked: a pinned @pome-sh version does not exist and never will.

${lines.join("\n")}

These pins are missing from npm AND disagree with packages/, so no packages-v*
batch is going to publish them. The later \`npm ci\` would fail anyway; failing
here names the pin instead of leaving a resolution error to be read.

Fix the pin in cli/package.json to match packages/, or publish the package it
names. See scripts/check-cli-pins-match-workspace.mjs — the PR-time gate that
should have caught this before it reached main.`);
    process.exitCode = 1;
    return;
  }

  const ready = pending.length === 0;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
  }

  if (ready) {
    console.log(`✅ All ${checked} pinned @pome-sh/* version(s) are published.`);
    return;
  }

  console.log(`⏳ Not releasing yet — ${pending.length} pinned version(s) are not on npm:

${pending.map(({ spec }) => `  ${spec}`).join("\n")}

Each matches its packages/ version, so this is the normal ordering: publish the
packages-v* batch first, then rerun this workflow.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
