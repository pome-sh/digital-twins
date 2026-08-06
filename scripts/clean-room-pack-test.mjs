#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Clean-room release gate for the two packages published to npm. (`@pome-sh/wire`
// is also published, but to GitHub Packages for cross-repo consumers, and is
// audited separately by scripts/ci/check-wire-tarball.mjs — F-949. What matters
// HERE is the assertion below that neither npm tarball declares an `@pome-sh/*`
// dependency: that is what keeps wire inlined rather than installed, and it must
// keep holding now that wire is resolvable-but-401 rather than nonexistent.)
//
// Packs `@pome-sh/cli` and `@pome-sh/adapter-claude-sdk`, installs each tarball
// into a throwaway directory with NO access to this workspace, and drives them
// the way a user would. This is the gate that would have caught the failure the
// restructure was built around: `bundleDependencies` declared seven packages and
// shipped none, npm trusted the declaration and skipped fetching them, the
// install reported success, and the CLI died on its first command.
//
// Both packages also get a files-field tarball audit (F-943): the real `tar`
// listing is grepped for dangling `.map` files and a compiled `dist/examples/`
// directory. tsup's `sourcemap: false` / `clean: true` config should already
// make both impossible, but that was previously an unverified claim about the
// build config, not an asserted property of the artifact actually published.
//
// The CLI checks:
//   - packed manifest declares no `@pome-sh/*` and no `file:` dependency
//   - no hard-link entries (npm registry rejects those with E415)
//   - no dangling `.map` files, no compiled `dist/examples/` directory
//   - `assets/` shipped (the fix-prompt system prompt is read at module scope)
//   - `pome --help` and `pome --version` run
//   - EVERY twin boots from the tarball and answers `/healthz` 200. All five,
//     not a sample: each twin is its own lazily-loaded chunk, so each is an
//     independent failure mode — a missing chunk or an unresolvable third-party
//     import (twin-linear needs `graphql`) only shows up on that twin's boot.
//
// The adapter checks:
//   - packed manifest declares no `@pome-sh/*` dependency (its wire types are
//     bundled; `@pome-sh/wire` is not installable by an end user)
//   - no dangling `.map` files, no compiled `dist/examples/` directory
//   - runtime import of `flushPomeTelemetry` with the peer installed
//   - a real consumer file TYPECHECKS against the shipped `dist/index.d.ts`.
//     Runtime-import-only would pass even if dts bundling dropped or
//     mis-resolved the bundled wire types: only the consumer's tsc breaks.
//
// Usage: node scripts/clean-room-pack-test.mjs [--keep]

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
  // --ignore-scripts: prepublishOnly would rebuild; the caller already built.
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

// F-943 tarball-files-field audit: `npm pack` respects each package's `files`
// field, but nothing previously asserted WHAT actually lands in the tgz.
// tsup's `sourcemap: false` / `clean: true` config (Lane D) means a stray
// `.map` or a leftover `dist/examples/` from a prior build shouldn't be
// possible today — but that's exactly the kind of invariant that silently
// stops holding the day someone flips a tsup option or a stale `dist/` gets
// packed without a clean rebuild. Grep the real tarball listing so a
// regression fails CI instead of shipping.
function assertNoStrayTarballArtifacts(tarball, label) {
  const listing = run("tar", ["-tf", tarball])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // npm wraps every entry in a top-level `package/` directory.
    .map((line) => line.replace(/^package\//, ""));

  const sourcemaps = listing.filter((path) => path.endsWith(".map"));
  if (sourcemaps.length > 0) {
    fail(`${label}: tarball contains dangling sourcemaps:\n${sourcemaps.join("\n")}`);
  }

  // A compiled `examples/` directory under `dist/` would mean the top-level
  // workspace `examples/` (standalone demo projects, never meant to publish)
  // got swept into the bundle output. `cli/examples/**` (raw .ts demo
  // agents) is a deliberate, separate top-level `files` entry — this only
  // guards the BUILD OUTPUT, not the package's own declared source examples.
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
      /* not listening yet */
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

// ── @pome-sh/cli ────────────────────────────────────────────────────────────
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

// ── @pome-sh/adapter-claude-sdk ─────────────────────────────────────────────
console.log("\n@pome-sh/adapter-claude-sdk — clean-room pack test");
const adapterRoom = makeRoom("adapter");
const adapterTarball = pack("@pome-sh/adapter-claude-sdk", join(adapterRoom, "tarballs"));
assertNoHardLinks(adapterTarball);
assertNoStrayTarballArtifacts(adapterTarball, "@pome-sh/adapter-claude-sdk");

const adapterInstall = join(adapterRoom, "install");
mkdirSync(adapterInstall, { recursive: true });
const peerRange = JSON.parse(
  readFileSync(join(ROOT, "packages", "adapter-claude-sdk", "package.json"), "utf8"),
).peerDependencies["@anthropic-ai/claude-agent-sdk"];
writeFileSync(
  join(adapterInstall, "package.json"),
  JSON.stringify({ name: "adapter-room", private: true, type: "module" }, null, 2),
);
run(
  "npm",
  [
    "install",
    adapterTarball,
    `@anthropic-ai/claude-agent-sdk@${peerRange}`,
    "typescript",
    "@types/node",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
  ],
  { cwd: adapterInstall },
);
assertManifestPure(
  join(adapterInstall, "node_modules", "@pome-sh", "adapter-claude-sdk", "package.json"),
  "@pome-sh/adapter-claude-sdk",
);

writeFileSync(
  join(adapterInstall, "runtime-check.mjs"),
  [
    'import { flushPomeTelemetry, withPome, tool, query, CORRELATION_HEADER } from "@pome-sh/adapter-claude-sdk";',
    'for (const [name, value] of Object.entries({ flushPomeTelemetry, withPome, tool, query })) {',
    '  if (typeof value !== "function") throw new Error(`${name} is not a function`);',
    "}",
    'if (typeof CORRELATION_HEADER !== "string") throw new Error("CORRELATION_HEADER is not a string");',
    "await flushPomeTelemetry();",
    'console.log("adapter runtime import OK");',
  ].join("\n"),
);
run(process.execPath, [join(adapterInstall, "runtime-check.mjs")], { cwd: adapterInstall });
console.log("  ✓ runtime import + flushPomeTelemetry()");

// Type-level check: the shipped dist/index.d.ts must typecheck for a real
// consumer. `tool()`'s generic binds through the peer SDK's zod-shaped
// `AnyZodRawShape`/`InferShape`, which is where bundled-dts breakage shows up.
writeFileSync(
  join(adapterInstall, "consumer.ts"),
  `import {
  withPome,
  tool,
  query,
  flushPomeTelemetry,
  CORRELATION_HEADER,
  ADAPTER_SIGNALS_ENV,
  OTEL_ENDPOINT_ENV,
  OTEL_HEADERS_ENV,
  type WithPomeOptions,
} from "@pome-sh/adapter-claude-sdk";
import { z } from "zod";

const opts: WithPomeOptions = { twinHosts: ["http://127.0.0.1:3333"] };
withPome(opts);

const header: string = CORRELATION_HEADER;
const envNames: string[] = [ADAPTER_SIGNALS_ENV, OTEL_ENDPOINT_ENV, OTEL_HEADERS_ENV];

// The generic must still bind from inputSchema so \`args\` stays typed.
const echo = tool("echo", "echo a message", { message: z.string() }, async (args) => {
  const message: string = args.message;
  return { content: [{ type: "text" as const, text: message }] };
});

export async function main(): Promise<void> {
  for await (const _message of query({ prompt: "hi" })) {
    void _message;
  }
  await flushPomeTelemetry();
  void [header, envNames, echo];
}
`,
);
writeFileSync(
  join(adapterInstall, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        // ESNext + DOM + @types/node because the peer SDK's OWN declarations
        // reference Response/AbortSignal/NodeJS/Symbol.dispose. A consumer that
        // could not compile those could not use the SDK at all.
        target: "ES2022",
        lib: ["ESNext", "DOM"],
        types: ["node"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        // Deliberately NOT skipLibCheck: the point is to check the SHIPPED
        // declarations, including the wire types dts bundling inlined into
        // them. With skipLibCheck the whole check degrades to "does the import
        // resolve", which the runtime check above already covers.
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    },
    null,
    2,
  ),
);
// zod is the peer SDK's own dependency; install it for the consumer's schema.
run("npm", ["install", "zod", "--no-audit", "--no-fund", "--ignore-scripts"], {
  cwd: adapterInstall,
});
try {
  run(join(adapterInstall, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: adapterInstall,
  });
} catch (err) {
  fail(
    "@pome-sh/adapter-claude-sdk: a consumer file failed to typecheck against the shipped dist/index.d.ts\n" +
      `${err.stdout ?? ""}${err.stderr ?? ""}`,
  );
}
console.log("  ✓ consumer file typechecks against the shipped dist/index.d.ts");

// ── @pome-sh/checks ─────────────────────────────────────────────────────────
//
// This package needs the consumer COMPILE more than either of the others, and it
// is the reason this section exists. Its whole job is to re-export declarations
// out of six `private: true` workspace packages, and `noExternal` governs only
// the JS bundle: the declaration bundler leaves bare `@pome-sh/*` specifiers
// behind, pointing at packages that are on no registry. The JS import keeps
// working, so nothing fails until a consumer runs `tsc` — 11 × TS2307 for the
// specifiers, and every DSL symbol behind `export * from "@pome-sh/sdk/checks"`
// missing outright. It shipped that way until a review caught it by hand.
//
// `skipLibCheck` is OFF, deliberately: with it on, an unresolvable specifier
// INSIDE a shipped `.d.ts` is silently tolerated and this degrades to "does the
// import resolve", which the runtime check already covers.
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
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
  ],
  { cwd: checksInstall },
);
// Same assertion as the other two, and it bites harder here: a leaked
// `@pome-sh/*` dependency would 404 rather than merely be redundant, because
// those packages are private at these versions.
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
// composition fails at the boundary (F-942, two schema identities).
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
writeFileSync(
  join(checksInstall, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        // No `lib: ["DOM"]` and no `types: ["node"]`, on purpose. A declarations
        // package has no business requiring either, and dropping them is what
        // catches an ambient leak — `NodeJS.ProcessEnv` reached the published
        // surface through a vendored `loadSeedFromEnv` signature and only showed
        // up once a consumer compiled without @types/node.
        lib: ["ES2022"],
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

cleanup();
console.log("\n✅ clean-room pack test passed for all three published packages.");
