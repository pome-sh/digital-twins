#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Clean-room release gate for the four npmjs-published packages. (`@pome-sh/wire`
// is also published, but to GitHub Packages for cross-repo consumers, and is
// audited separately by scripts/ci/check-wire-tarball.mjs. What matters
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
// Both packages also get a files-field tarball audit: the real `tar`
// listing is grepped for dangling `.map` files and a compiled `dist/examples/`
// directory. tsup's `sourcemap: false` / `clean: true` config should already
// make both impossible, but that is an unverified claim about the
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
// `@pome-sh/checks` and `@pome-sh/sandbox-domains` get their own sections at the
// bottom — the two packages whose only consumer is in another repository, and
// the two where a runtime import proves the least. checks needs the consumer
// COMPILE (its whole job is re-exported declarations); sandbox-domains needs the
// consumer CONSTRUCTION (its openers must actually open a database), and its
// install deliberately names nothing but the tarball, its zod peer and
// typescript, so anything else it needs has to arrive through its own
// `dependencies`.
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

// Tarball-files-field audit: `npm pack` respects each package's `files`
// field, and nothing else asserts WHAT actually lands in the tgz.
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

  // A compiled `agent-examples/` directory under `dist/` would mean the top-level
  // workspace `agent-examples/` (standalone demo projects, never meant to publish)
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

// ── @pome-sh/sandbox-domains ───────────────────────────────────────────────────
//
// The grading RUNTIME, and the one published package where "the import
// resolves" is genuinely not enough: pome-cloud does not just read these
// exports, it CONSTRUCTS them — opens a SQLite database, builds a domain over
// it, and parses a seed through it. A tarball whose `open*Database` resolves and
// then cannot open anything satisfies every name-shaped assertion and fails on
// the grader, which is why the runtime check below boots rather than imports.
//
// `skipLibCheck` stays OFF for the same reason as checks above, and it reaches
// further here: this package's declarations legitimately name three EXTERNAL
// packages (`hono`, `@octokit/openapi-types`, `stripe`) that its manifest must
// therefore declare. Installing the tarball alone — with no workspace, and
// without hand-installing those — is what proves the manifest actually carries
// them. It is the assertion that would have caught `graphql` being declared for
// a package tsup had inlined, and `@hono/node-server` being declared for one
// nothing imported.
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
// Only the tarball, its zod PEER and typescript are named here. Everything else
// the package needs has to arrive through its own `dependencies`, which is the
// point of the exercise.
// `@types/node` is here and is NOT a hole in the exercise. This package opens
// SQLite databases through `node:sqlite`, and its shipped declarations reach
// `hono`'s and `stripe`'s own `.d.ts`, which require `@types/node` and the DOM
// lib themselves (neither declares `@types/node`; both assume a Node consumer,
// which is standard for a server library). A consumer of a package like this is
// a Node server — pome-cloud's control-plane — so requiring those is honest.
// What is NOT installed is anything that would let this package's own missing
// `dependencies` pass unnoticed: `hono`, `@octokit/openapi-types` and `stripe`
// must all still arrive through the tarball's own manifest.
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
        // DOM and `@types/node` ARE allowed here, and that is the one place this
        // room deliberately differs from the checks room above. The reason there
        // ("a declarations package has no business requiring either") does not
        // transfer: this package is a RUNTIME. Its declarations reach hono's and
        // stripe's own `.d.ts`, which name `File`, `Request`, `ReadableStream`
        // and `NodeJS.*` — third-party types that need those libs and are not
        // this repo's to fix.
        //
        // `skipLibCheck` stays OFF, which is what keeps the assertion worth
        // making: the tarball installs INTO node_modules, so turning it on would
        // skip this package's own declarations too and degrade the whole section
        // to "does the import resolve" — which the runtime check already covers.
        // The cost is that a genuine type regression shipped by hono or stripe
        // reds this gate; renovate keeps both current and the rest of the repo's
        // typecheck already carries the same exposure.
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
