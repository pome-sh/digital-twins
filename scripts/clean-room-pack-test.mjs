#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Clean-room release gate for the two published packages.
//
// Packs `@pome-sh/cli` and `@pome-sh/adapter-claude-sdk`, installs each tarball
// into a throwaway directory with NO access to this workspace, and drives them
// the way a user would. This is the gate that would have caught the failure the
// restructure was built around: `bundleDependencies` declared seven packages and
// shipped none, npm trusted the declaration and skipped fetching them, the
// install reported success, and the CLI died on its first command.
//
// The CLI checks:
//   - packed manifest declares no `@pome-sh/*` and no `file:` dependency
//   - no hard-link entries (npm registry rejects those with E415)
//   - `assets/` shipped (the fix-prompt system prompt is read at module scope)
//   - `pome --help` and `pome --version` run
//   - EVERY twin boots from the tarball and answers `/healthz` 200. All five,
//     not a sample: each twin is its own lazily-loaded chunk, so each is an
//     independent failure mode — a missing chunk or an unresolvable third-party
//     import (twin-linear needs `graphql`) only shows up on that twin's boot.
//
// The adapter checks:
//   - packed manifest declares no `@pome-sh/*` dependency (its wire types are
//     bundled; `@pome-sh/shared-types` is private)
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

cleanup();
console.log("\n✅ clean-room pack test passed for both published packages.");
