#!/usr/bin/env node
// Writes `dist/build-info.json`, baking the git SHA and ISO build timestamp
// into the published tarball (F6). CI sets POME_GIT_SHA and POME_BUILD_TIME
// ahead of the build; locally we best-effort resolve the SHA via
// `git rev-parse HEAD`. Falls back to "dev" so a contributor install
// (`npm install -g .`) still produces a working — if uninformative —
// `pome health` runtime block.
//
// This script used to also copy `src/fix-prompt/prompts/` and the demo task
// assets into the mirrored `dist/src/...` tree. Those assets now live at
// `<packageRoot>/assets/**` and ship as-is via cli/package.json `files`, so
// there is nothing left to copy: see src/cli/assets.ts for why a bundled CLI
// cannot resolve an asset relative to its importing module.

import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await writeBuildInfo();

async function writeBuildInfo() {
  const buildInfo = {
    package: "pome-sh",
    version: await readPackageVersion(),
    git_sha: resolveGitSha(),
    build_time: process.env.POME_BUILD_TIME ?? new Date().toISOString(),
  };
  await mkdir(resolve(CLI_ROOT, "dist"), { recursive: true });
  await writeFile(
    resolve(CLI_ROOT, "dist", "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );
}

async function readPackageVersion() {
  try {
    const raw = await readFile(resolve(CLI_ROOT, "package.json"), "utf8");
    const json = JSON.parse(raw);
    return typeof json.version === "string" ? json.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveGitSha() {
  // CI sets this explicitly (cleaner than depending on a usable git checkout
  // inside the runner). Falls back to `git rev-parse` for local builds, then
  // "dev" for contributor installs that landed without a .git directory.
  if (process.env.POME_GIT_SHA) return process.env.POME_GIT_SHA;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", {
      cwd: CLI_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}
