// SPDX-License-Identifier: Apache-2.0
//
// F-713 — packed-CLI smoke: prove the SHIPPED artifact set works, not the
// workspace. The CLI is staged exactly as published (files list + `npm
// install` materializing the vendored @pome-sh/* tarballs + `npm pack`
// honouring bundleDependencies), installed into a clean temp project, and
// then `pome run --local` must boot the ENGINE-BASED slack twin from the
// bundled tarballs: the scripted agent probes `GET /healthz` (root, no auth)
// and the bearer-authed session `_pome/health` route, and this script
// re-validates the recorded healthz body against the frozen runtime contract
// (CONTRACT.md: `{ok, twin, implementation, tools, runtime}`; slack carries
// no version/fidelity extras — `version` lives in `runtime.version` and the
// per-twin table pins the `fidelity` field as absent for slack).
//
// Run locally (after `bun install && bun run build` in cli/):
//   node scripts/packed-smoke.mjs
// CI: the `packed-smoke` job in .github/workflows/cli-ci.yml.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sh = (cmd, cwd, extraArgs, env) =>
  execFileSync(cmd, extraArgs, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
  });

function fail(message) {
  console.error(`packed-smoke: FAIL — ${message}`);
  process.exit(1);
}

if (!existsSync(join(cliRoot, "dist/src/cli/main.js"))) {
  fail("cli/dist is missing — run `bun run build` in cli/ first");
}

const tempDirs = [];
const mkTemp = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `pome-packed-smoke-${label}-`));
  tempDirs.push(dir);
  return dir;
};

try {
  // ── 1. Stage the publishable file set and produce the npm tarball ────────
  // bun installs symlinked node_modules, which `npm pack` will not bundle;
  // stage a physical copy and materialize node_modules/@pome-sh/* by
  // EXTRACTING the committed vendor/ tarballs (a staging `npm install` hangs:
  // Arborist cannot settle the workspace-self + overrides + nested-bundle
  // manifest, the same class of problem scripts/pack-publishable.mjs works
  // around for the adapter). `npm pack` bundles the extracted subtrees as-is
  // per bundleDependencies; everything else resolves from the registry at the
  // consumer's `npm install <tgz>` exactly like a published install.
  const staging = mkTemp("stage");
  const pkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
  for (const entry of new Set([...(pkg.files ?? []), "package.json"])) {
    const src = join(cliRoot, entry);
    if (existsSync(src)) cpSync(src, join(staging, entry), { recursive: true });
  }
  // `npm pack` runs the `prepare` lifecycle even under --ignore-scripts
  // (long-standing npm behavior); dist/ is prebuilt and tsconfig.build.json
  // is deliberately not part of the shipped file set. `prepare` never runs
  // on tarball installs, so dropping it from the staged manifest does not
  // change the consumer flow under test.
  const stagedManifest = { ...pkg, scripts: { ...pkg.scripts } };
  delete stagedManifest.scripts.prepare;
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);
  console.error("packed-smoke: extracting vendored tarballs into staging node_modules…");
  const vendorSpecs = Object.entries(pkg.dependencies ?? {}).filter(
    ([, spec]) => typeof spec === "string" && spec.startsWith("file:./vendor/"),
  );
  for (const [name, spec] of vendorSpecs) {
    const tgz = join(staging, spec.slice("file:./".length));
    const dest = join(staging, "node_modules", name);
    mkdirSync(dest, { recursive: true });
    sh("tar", staging, ["-xzf", tgz, "-C", dest, "--strip-components=1"]);
  }
  for (const name of pkg.bundleDependencies ?? []) {
    if (!existsSync(join(staging, "node_modules", name, "package.json"))) {
      fail(`bundleDependencies entry ${name} has no vendored tarball to extract`);
    }
  }
  console.error("packed-smoke: npm pack…");
  // --ignore-scripts: dist/ is prebuilt (`bun run build` precondition); the
  // `prepare` hook would try to rebuild without tsconfig.build.json in the
  // staged file set.
  const tgzName = sh("npm", staging, ["pack", "--silent", "--ignore-scripts"]).trim().split("\n").pop().trim();
  const tgzPath = join(staging, tgzName);
  console.error(`packed-smoke: packed ${tgzName}`);

  // ── 2. Clean-room install of the packed CLI ──────────────────────────────
  const room = mkTemp("room");
  writeFileSync(join(room, "package.json"), JSON.stringify({ name: "packed-smoke-room", private: true }));
  console.error("packed-smoke: clean-room npm install (builds better-sqlite3)…");
  sh("npm", room, ["install", tgzPath, "--no-audit", "--no-fund"]);

  // The bundled artifact set must physically contain the engine and the
  // ENGINE-BASED slack twin (the wire is contract-frozen, so "engine-based"
  // is only provable from the artifact: dist/src/twin.js is the defineTwin()
  // assembly, and its manifest declares the sdk dep).
  const installedCli = join(room, "node_modules/pome-sh");
  const bundledSdk = join(installedCli, "node_modules/@pome-sh/sdk/dist/server.js");
  if (!existsSync(bundledSdk)) fail(`bundled @pome-sh/sdk missing (${bundledSdk})`);
  const bundledTwinManifest = join(installedCli, "node_modules/@pome-sh/twin-slack/package.json");
  const twinManifest = JSON.parse(readFileSync(bundledTwinManifest, "utf8"));
  if (!twinManifest.dependencies?.["@pome-sh/sdk"]) {
    fail("bundled @pome-sh/twin-slack does not declare the @pome-sh/sdk dep — pre-engine tarball?");
  }
  if (!existsSync(join(installedCli, "node_modules/@pome-sh/twin-slack/dist/src/twin.js"))) {
    fail("bundled @pome-sh/twin-slack is missing dist/src/twin.js (the defineTwin() assembly)");
  }
  console.error("packed-smoke: bundled engine + engine-based twin-slack present");

  // ── 3. pome run --local boots the slack twin; agent probes /healthz ──────
  const work = mkTemp("work");
  writeFileSync(join(work, "pome.config.json"), "{}\n");
  writeFileSync(
    join(work, "scenario.md"),
    [
      "# Packed-CLI smoke — slack twin boot",
      "",
      "## Prompt",
      "",
      "Probe the slack twin health endpoints.",
      "",
      "## Success Criteria",
      "",
      "- [P] The health probe reported the twin as reachable (capture-only run; never judged locally)",
      "",
      "## Config",
      "",
      "```yaml",
      'twins: ["slack"]',
      "```",
      "",
    ].join("\n"),
  );
  // The probe agent: root /healthz (no auth) + bearer-authed session
  // _pome/health, recorded to healthz-probe.json for re-validation below.
  writeFileSync(
    join(work, "agent.mjs"),
    [
      "import { writeFileSync } from 'node:fs';",
      "const rest = process.env.POME_SLACK_REST_URL;",
      "const token = process.env.POME_AUTH_TOKEN;",
      "if (!rest || !token) { console.error('missing POME_SLACK_REST_URL / POME_AUTH_TOKEN'); process.exit(1); }",
      "const root = new URL(rest).origin;",
      "const health = await fetch(`${root}/healthz`);",
      "const body = await health.json();",
      "const session = await fetch(`${rest}/_pome/health`, { headers: { Authorization: `Bearer ${token}` } });",
      "const sessionBody = await session.json();",
      "writeFileSync('healthz-probe.json', JSON.stringify({ status: health.status, body, session: { status: session.status, body: sessionBody } }, null, 2));",
      "if (health.status !== 200 || body.ok !== true) { console.error(`healthz not ok: ${health.status}`); process.exit(1); }",
      "if (session.status !== 200 || sessionBody.ok !== true) { console.error(`session health not ok: ${session.status}`); process.exit(1); }",
      "console.log('healthz probe ok');",
      "",
    ].join("\n"),
  );
  const pomeBin = join(room, "node_modules/.bin/pome");
  console.error("packed-smoke: pome run --local (packed binary)…");
  sh(pomeBin, work, ["run", "--local", "scenario.md", "--agent", "node agent.mjs"]);

  // ── 4. Re-validate the recorded healthz body (frozen contract shape) ─────
  const probePath = join(work, "healthz-probe.json");
  if (!existsSync(probePath)) fail("agent never wrote healthz-probe.json");
  const probe = JSON.parse(readFileSync(probePath, "utf8"));
  const { status, body, session } = probe;
  if (status !== 200) fail(`GET /healthz answered ${status}, want 200`);
  if (body.ok !== true) fail(`healthz.ok = ${JSON.stringify(body.ok)}, want true`);
  if (body.twin !== "slack") fail(`healthz.twin = ${JSON.stringify(body.twin)}, want "slack"`);
  if (body.implementation !== "slack_clone") {
    fail(`healthz.implementation = ${JSON.stringify(body.implementation)}, want "slack_clone"`);
  }
  if (typeof body.tools !== "number" || body.tools <= 0) {
    fail(`healthz.tools = ${JSON.stringify(body.tools)}, want a positive count`);
  }
  if (body.runtime?.package !== "@pome-sh/twin-slack") {
    fail(`healthz.runtime.package = ${JSON.stringify(body.runtime?.package)}, want "@pome-sh/twin-slack"`);
  }
  if (typeof body.runtime?.version !== "string" || body.runtime.version.length === 0) {
    fail(`healthz.runtime.version = ${JSON.stringify(body.runtime?.version)}, want a non-empty string`);
  }
  // Frozen per-twin difference (CONTRACT.md): slack /healthz carries NO
  // top-level version/fidelity extras. A twin that starts emitting them is a
  // wire diff, not an improvement.
  if ("fidelity" in body) fail("healthz gained a `fidelity` field — slack's frozen shape has none");
  if ("version" in body) fail("healthz gained a top-level `version` field — slack pins version under runtime.version");
  if (session.status !== 200 || session.body?.ok !== true) {
    fail(`session _pome/health answered ${session.status} / ${JSON.stringify(session.body)}`);
  }

  console.error(
    `packed-smoke: OK — packed ${tgzName} boots the engine-based slack twin; ` +
      `healthz 200 {twin: slack, tools: ${body.tools}, runtime.version: ${body.runtime.version}}`,
  );
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
} catch (err) {
  console.error(`packed-smoke: kept temp dirs for debugging:\n  ${tempDirs.join("\n  ")}`);
  throw err;
}
