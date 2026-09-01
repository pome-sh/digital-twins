#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Installs both tarballs in a clean room and boots every twin from them, which is
// the only place a missing `files` entry or a leaked dep actually shows up.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");

const TWINS = [
  { name: "github", port: 3401 },
  { name: "slack", port: 3402 },
  { name: "stripe", port: 3403 },
  { name: "gmail", port: 3404 },
  { name: "linear", port: 3405 },
];

const rooms = [];
function makeRoom(label) {
  const dir = mkdtempSync(join(tmpdir(), `pome-cleanroom-${label}-`));
  rooms.push(dir);
  return dir;
}
function cleanup() {
  if (KEEP) {
    console.log(`\n--keep: left clean rooms at\n  ${rooms.join("\n  ")}`);
    return;
  }
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true });
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function fail(message) {
  console.error(`\n❌ ${message}`);
  cleanup();
  process.exit(1);
}

function pack(workspace, destination) {
  mkdirSync(destination, { recursive: true });
  run("npm", ["pack", "-w", workspace, "--ignore-scripts", "--pack-destination", destination], {
    cwd: ROOT,
  });
  const tarball = readdirSync(destination).find((file) => file.endsWith(".tgz"));
  if (!tarball) fail(`npm pack -w ${workspace} produced no tarball in ${destination}`);
  return join(destination, tarball);
}

function assertNoHardLinks(tarball) {
  const listing = run("tar", ["-tvf", tarball]);
  const hardLinks = listing.split("\n").filter((line) => line.startsWith("h"));
  if (hardLinks.length > 0) {
    fail(`tarball contains hard links — npm would reject with E415:\n${hardLinks.join("\n")}`);
  }
}

function assertNoStrayTarballArtifacts(tarball, label) {
  const listing = run("tar", ["-tf", tarball])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ""));

  const sourcemaps = listing.filter((path) => path.endsWith(".map"));
  if (sourcemaps.length > 0) {
    fail(`${label}: tarball contains dangling sourcemaps:\n${sourcemaps.join("\n")}`);
  }

  const compiledExamples = listing.filter((path) => /^dist\/.*\bexamples\//.test(path));
  if (compiledExamples.length > 0) {
    fail(`${label}: tarball's dist/ contains a compiled examples/ directory:\n${compiledExamples.join("\n")}`);
  }

  console.log(`  ✓ ${label}: no dangling sourcemaps, no compiled dist/examples/`);
}

function assertManifestPure(installedPkgPath, label) {
  const manifest = JSON.parse(readFileSync(installedPkgPath, "utf8"));
  const deps = { ...(manifest.dependencies ?? {}) };
  const internal = Object.keys(deps).filter((dep) => dep.startsWith("@pome-sh/"));
  if (internal.length > 0) {
    fail(`${label}: packed manifest declares private internal deps: ${internal.join(", ")}`);
  }
  const local = Object.entries(deps).filter(
    ([, spec]) => typeof spec === "string" && (spec.startsWith("file:") || spec.startsWith("link:")),
  );
  if (local.length > 0) {
    fail(`${label}: packed manifest declares local-path deps: ${local.map(([d]) => d).join(", ")}`);
  }
  if (manifest.bundleDependencies) {
    fail(`${label}: packed manifest still declares bundleDependencies`);
  }
  console.log(`  ✓ ${label}: manifest pure (no @pome-sh/*, no file:, no bundleDependencies)`);
  return manifest;
}

async function waitForHealth(port, child, twin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return `process exited with code ${child.exitCode}`;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200) {
        const body = await response.json();
        if (body?.ok !== true) return `/healthz 200 but body was ${JSON.stringify(body)}`;
        if (body?.twin !== twin) return `/healthz reported twin "${body?.twin}", expected "${twin}"`;
        return null;
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return "no /healthz 200 within 60s";
}

async function bootTwinFromTarball(room, cliBin, twin, port) {
  const child = spawn(process.execPath, [cliBin, "twin", "start", twin, "--port", String(port)], {
    cwd: room,
    env: { ...process.env, TWIN_AUTH_SECRET: "clean-room-secret-0123456789abcdef" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    const problem = await waitForHealth(port, child, twin);
    if (problem) fail(`twin ${twin} from the tarball: ${problem}\n--- twin output ---\n${log}`);
    console.log(`  ✓ ${twin}: booted from the tarball, /healthz 200`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        r();
      });
    });
  }
}

console.log("\n@pome-sh/cli — clean-room pack test");
const cliRoom = makeRoom("cli");
const cliTarball = pack("@pome-sh/cli", join(cliRoom, "tarballs"));
assertNoHardLinks(cliTarball);
assertNoStrayTarballArtifacts(cliTarball, "@pome-sh/cli");

const cliInstall = join(cliRoom, "install");
mkdirSync(cliInstall, { recursive: true });
writeFileSync(join(cliInstall, "package.json"), JSON.stringify({ name: "room", private: true }));
run("npm", ["install", cliTarball, "--no-audit", "--no-fund", "--ignore-scripts"], {
  cwd: cliInstall,
});

const cliPkgRoot = join(cliInstall, "node_modules", "@pome-sh", "cli");
assertManifestPure(join(cliPkgRoot, "package.json"), "@pome-sh/cli");

const cliBin = join(cliPkgRoot, "dist", "src", "cli", "main.js");
if (!existsSync(cliBin)) fail(`@pome-sh/cli: bin entry missing from the tarball (${cliBin})`);
for (const asset of [
  join("assets", "fix-prompt", "prompts", "fix-prompt-v1.md"),
  join("assets", "demo", "first-run-demo.md"),
  join("assets", "demo", "first-run-demo.seed.json"),
]) {
  if (!existsSync(join(cliPkgRoot, asset))) {
    fail(`@pome-sh/cli: runtime asset missing from the tarball: ${asset}`);
  }
}
console.log("  ✓ bin entry + runtime assets present");

const help = run(process.execPath, [cliBin, "--help"], { cwd: cliInstall });
if (!help.includes("pome")) fail(`@pome-sh/cli: --help output looked wrong:\n${help}`);
const version = run(process.execPath, [cliBin, "--version"], { cwd: cliInstall }).trim();
const localVersion = JSON.parse(readFileSync(join(ROOT, "cli", "package.json"), "utf8")).version;
if (version !== localVersion) {
  fail(`@pome-sh/cli: --version reported ${version}, expected ${localVersion} (PKG_VERSION define)`);
}
console.log(`  ✓ --help and --version (${version}) run from the tarball`);

for (const { name, port } of TWINS) {
  await bootTwinFromTarball(cliInstall, cliBin, name, port);
}

console.log("\n@pome-sh/checks — clean-room pack test");
const checksRoom = makeRoom("checks");
const checksTarball = pack("@pome-sh/checks", join(checksRoom, "tarballs"));
assertNoHardLinks(checksTarball);
assertNoStrayTarballArtifacts(checksTarball, "@pome-sh/checks");

const checksInstall = join(checksRoom, "install");
mkdirSync(checksInstall, { recursive: true });
writeFileSync(
  join(checksInstall, "package.json"),
  JSON.stringify({ name: "checks-room", private: true, type: "module" }, null, 2),
);
// The range, not the workspace lockfile's pin: a fresh consumer resolves the
// newest zod satisfying `^4.x`, and this room exists to be that consumer.
const zodRange = JSON.parse(
  readFileSync(join(ROOT, "packages", "checks", "package.json"), "utf8"),
).peerDependencies.zod;
run(
  "npm",
  [
    "install",
    checksTarball,
    `zod@${zodRange}`,
    "typescript",
    "@types/node",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
  ],
  { cwd: checksInstall },
);
assertManifestPure(
  join(checksInstall, "node_modules", "@pome-sh", "checks", "package.json"),
  "@pome-sh/checks",
);

writeFileSync(
  join(checksInstall, "runtime-check.mjs"),
  [
    'import { GITHUB_CHECKS, TWIN_CHECKS, defineCheck, checksDigest, parseGitHubSeed, defaultGitHubSeed } from "@pome-sh/checks";',
    'import { STRIPE_CHECKS } from "@pome-sh/checks/stripe";',
    'import { defineCheck as viaDsl } from "@pome-sh/checks/dsl";',
    'if (!Array.isArray(GITHUB_CHECKS) || GITHUB_CHECKS.length === 0) throw new Error("GITHUB_CHECKS is empty");',
    'if (Object.keys(TWIN_CHECKS).length !== 5) throw new Error("TWIN_CHECKS does not cover five twins");',
    'if (typeof defineCheck !== "function") throw new Error("defineCheck is not a function");',
    "// One copy of the DSL across entries, or the barrel and a subpath hand out",
    "// different objects for the same primitive (the splitting: true invariant).",
    'if (viaDsl !== defineCheck) throw new Error("defineCheck differs between ./dsl and the barrel");',
    'if (!checksDigest(GITHUB_CHECKS).startsWith("sha256:")) throw new Error("checksDigest returned junk");',
    "// The seed round-trip is the other half of what pome-cloud actually does.",
    "parseGitHubSeed(defaultGitHubSeed());",
    'if (STRIPE_CHECKS.length === 0) throw new Error("STRIPE_CHECKS is empty");',
    'console.log("checks runtime import OK");',
  ].join("\n"),
);
run(process.execPath, [join(checksInstall, "runtime-check.mjs")], { cwd: checksInstall });
console.log("  ✓ runtime import, one-copy DSL identity, seed round-trip");

writeFileSync(
  join(checksInstall, "consumer.ts"),
  `import {
  GITHUB_CHECKS,
  TWIN_CHECKS,
  CHECKS_TWIN_NAMES,
  defineCheck,
  renderCheck,
  parseCheck,
  checkPattern,
  checksDigest,
  templateSlots,
  statePath,
  childStatePath,
  parseGitHubSeed,
  githubSeedSchema,
  defaultGitHubSeed,
  type GitHubCheck,
  type GitHubCheckState,
  type ChecksTwinName,
  type CheckDefinition,
} from "@pome-sh/checks";
import { GITHUB_CHECKS as viaSubpath, parseSeed, seedSchema } from "@pome-sh/checks/github";
import { z } from "zod";

// The element type is the surface pome-cloud's resolveTwinChecks binds against.
const first: GitHubCheck<Record<string, string>> = GITHUB_CHECKS[0]!;
const id: string = first.id;
const generic: CheckDefinition<GitHubCheckState, Record<string, string>> = first;
const pattern: RegExp = checkPattern(first);
const digest: string = checksDigest(GITHUB_CHECKS);
const slots: { literals: string[]; params: string[] } = templateSlots(first.template);
const twin: ChecksTwinName = CHECKS_TWIN_NAMES[0];
const everyTwin: readonly unknown[] = TWIN_CHECKS[twin];

// The seed schema must be a zod schema built from the CONSUMER's zod, or
// composition fails at the boundary (two schema identities).
const composed = z.object({ seed: githubSeedSchema });
const parsed = parseGitHubSeed(defaultGitHubSeed());
const alsoParsed = parseSeed(defaultGitHubSeed());

export function main(): void {
  void [
    id, generic, pattern, digest, slots, twin, everyTwin, composed, parsed, alsoParsed,
    viaSubpath, seedSchema, defineCheck, renderCheck, parseCheck, statePath, childStatePath,
  ];
}
`,
);
// `skipLibCheck: false` is the whole point — it is what makes a shipped `.d.ts`
// that names an unresolvable specifier a failure instead of a warning. The price
// is that the peer's declarations are checked too, so the room needs the ambient
// libs a real consumer has. `lib: ["ES2022"]` alone declares no `URL`, and zod
// 4.5 types `parseURLObject` as returning one: the gate reddened on zod's own
// `schemas.d.cts`, naming @pome-sh/checks. The two other rooms below and above
// carried DOM + node types already and were unaffected; this one was the outlier.
// Do NOT "fix" a future recurrence by turning `skipLibCheck` on or by pinning zod
// here — either mutes the failure class this gate exists to catch.
writeFileSync(
  join(checksInstall, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    },
    null,
    2,
  ),
);
try {
  run(join(checksInstall, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: checksInstall,
  });
} catch (err) {
  fail(
    "@pome-sh/checks: a consumer file failed to typecheck against the shipped declarations.\n" +
      "This is the failure mode `noExternal` does not cover — the declaration bundler leaves\n" +
      "bare @pome-sh/* specifiers that resolve nowhere for a consumer, and the JS keeps working.\n" +
      `${err.stdout ?? ""}${err.stderr ?? ""}`,
  );
}
console.log("  ✓ consumer file typechecks against the shipped declarations (skipLibCheck off)");

console.log("\n@pome-sh/sandbox-domains — clean-room pack test");
const domainsRoom = makeRoom("sandbox-domains");
const domainsTarball = pack("@pome-sh/sandbox-domains", join(domainsRoom, "tarballs"));
assertNoHardLinks(domainsTarball);
assertNoStrayTarballArtifacts(domainsTarball, "@pome-sh/sandbox-domains");

const domainsInstall = join(domainsRoom, "install");
mkdirSync(domainsInstall, { recursive: true });
writeFileSync(
  join(domainsInstall, "package.json"),
  JSON.stringify({ name: "sandbox-domains-room", private: true, type: "module" }, null, 2),
);
const domainsZodRange = JSON.parse(
  readFileSync(join(ROOT, "packages", "sandbox-domains", "package.json"), "utf8"),
).peerDependencies.zod;
run(
  "npm",
  [
    "install",
    domainsTarball,
    `zod@${domainsZodRange}`,
    "typescript",
    "@types/node",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
  ],
  { cwd: domainsInstall },
);
assertManifestPure(
  join(domainsInstall, "node_modules", "@pome-sh", "sandbox-domains", "package.json"),
  "@pome-sh/sandbox-domains",
);

writeFileSync(
  join(domainsInstall, "runtime-check.mjs"),
  [
    'import { SANDBOX_DOMAINS, SANDBOX_DOMAIN_NAMES, toTwinHttpEventRow } from "@pome-sh/sandbox-domains";',
    'import { GitHubDomain, openGitHubCloneDatabase, parseSeed, defaultSeedState, GITHUB_CHECKS } from "@pome-sh/sandbox-domains/github";',
    'import { StripeDomain, openTwinStripeDatabase, applySeed } from "@pome-sh/sandbox-domains/stripe";',
    'import { toTwinHttpEventRow as viaServer } from "@pome-sh/sandbox-domains/server";',
    'if (SANDBOX_DOMAIN_NAMES.length !== 5) throw new Error("SANDBOX_DOMAIN_NAMES does not cover five twins");',
    'if (Object.keys(SANDBOX_DOMAINS).length !== 5) throw new Error("SANDBOX_DOMAINS does not cover five twins");',
    "// One copy across entries, or the barrel and a subpath hand out different",
    "// objects for the same primitive (the splitting: true invariant).",
    'if (viaServer !== toTwinHttpEventRow) throw new Error("toTwinHttpEventRow differs between ./server and the barrel");',
    'if (SANDBOX_DOMAINS.github.Domain !== GitHubDomain) throw new Error("barrel and subpath disagree on GitHubDomain");',
    "// The part a name-shaped check cannot reach: node:sqlite actually opens,",
    "// and a domain constructs over the handle it returns.",
    'const db = openGitHubCloneDatabase(":memory:");',
    'if (!(new GitHubDomain(db) instanceof GitHubDomain)) throw new Error("GitHubDomain did not construct");',
    "parseSeed(defaultSeedState());",
    'if (GITHUB_CHECKS.length === 0) throw new Error("GITHUB_CHECKS is empty");',
    'if (typeof applySeed !== "function") throw new Error("stripe applySeed missing");',
    'const sdb = openTwinStripeDatabase(":memory:");',
    'if (!(new StripeDomain(sdb) instanceof StripeDomain)) throw new Error("StripeDomain did not construct");',
    'const row = toTwinHttpEventRow({ request_id: "req_1" });',
    'if (row.kind !== "TwinHttpEvent" || row.event_id !== "req_1") throw new Error("toTwinHttpEventRow did not wrap the row");',
    'console.log("sandbox-domains runtime import, database open and domain construction OK");',
  ].join("\n"),
);
run(process.execPath, [join(domainsInstall, "runtime-check.mjs")], { cwd: domainsInstall });
console.log("  ✓ runtime import, one-copy identity, real SQLite open + domain construction");

writeFileSync(
  join(domainsInstall, "consumer.ts"),
  `import {
  SANDBOX_DOMAINS,
  SANDBOX_DOMAIN_NAMES,
  type SandboxDomainName,
  toTwinHttpEventRow,
} from "@pome-sh/sandbox-domains";
import {
  GitHubDomain,
  openGitHubCloneDatabase,
  parseSeed,
  defaultSeedState,
  GITHUB_CHECKS,
} from "@pome-sh/sandbox-domains/github";
import { StripeDomain, openTwinStripeDatabase, applySeed, type TwinStripeDatabase } from "@pome-sh/sandbox-domains/stripe";
import { GmailDomain, openGmailTwinDatabase } from "@pome-sh/sandbox-domains/gmail";
import { LinearDomain, openLinearTwinDatabase } from "@pome-sh/sandbox-domains/linear";
import { SlackDomain, openSlackTwinDatabase } from "@pome-sh/sandbox-domains/slack";

const names: readonly SandboxDomainName[] = SANDBOX_DOMAIN_NAMES;
const github = new GitHubDomain(openGitHubCloneDatabase(":memory:"));
const stripeDb: TwinStripeDatabase = openTwinStripeDatabase(":memory:");
const stripe = new StripeDomain(stripeDb);
const gmail = new GmailDomain(openGmailTwinDatabase(":memory:"));
const linear = new LinearDomain(openLinearTwinDatabase(":memory:"));
const slack = new SlackDomain(openSlackTwinDatabase(":memory:"));
const parsed = parseSeed(defaultSeedState());
const row = toTwinHttpEventRow({ request_id: "req_1" } as never);
const kind: "TwinHttpEvent" = row.kind;

export function main(): void {
  void [
    names, SANDBOX_DOMAINS, github, stripe, gmail, linear, slack, parsed, kind,
    GITHUB_CHECKS, applySeed,
  ];
}
`,
);
writeFileSync(
  join(domainsInstall, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    },
    null,
    2,
  ),
);
try {
  run(join(domainsInstall, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: domainsInstall,
  });
} catch (err) {
  fail(
    "@pome-sh/sandbox-domains: a consumer file failed to typecheck against the shipped declarations.\n" +
      "Either the declaration bundler left a bare @pome-sh/* specifier (the failure `noExternal`\n" +
      "does not cover), or the shipped `.d.ts` names an external — hono, @octokit/openapi-types,\n" +
      "stripe — that the package's own `dependencies` do not carry.\n" +
      `${err.stdout ?? ""}${err.stderr ?? ""}`,
  );
}
console.log("  ✓ consumer file typechecks against the shipped declarations (skipLibCheck off)");

cleanup();
console.log("\n✅ clean-room pack test passed for all four published packages.");
