// SPDX-License-Identifier: Apache-2.0
//
// Builds every workspace in dependency order.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_SCOPE = "@pome-sh/";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function listWorkspaceDirectories() {
  const result = spawnSync("npm", ["query", ".workspace", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(
      `\`npm query .workspace\` failed (exit ${result.status}):\n${result.stderr ?? ""}`,
    );
  }
  const entries = JSON.parse(result.stdout);
  return entries.map((entry) => entry.path ?? resolve(ROOT, entry.location));
}

function readManifest(directory) {
  return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
}

function loadGraph() {
  const nodes = new Map();
  for (const directory of listWorkspaceDirectories()) {
    const manifest = readManifest(directory);
    if (!manifest.name) continue;
    const dependsOn = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const specifier of Object.keys(manifest[field] ?? {})) {
        if (specifier.startsWith(INTERNAL_SCOPE)) dependsOn.add(specifier);
      }
    }
    nodes.set(manifest.name, {
      directory,
      hasBuild: typeof manifest.scripts?.build === "string",
      dependsOn,
    });
  }
  for (const node of nodes.values()) {
    for (const dependency of [...node.dependsOn]) {
      if (!nodes.has(dependency)) node.dependsOn.delete(dependency);
    }
  }
  return nodes;
}

function topoSort(nodes) {
  const remaining = new Map([...nodes].map(([name, node]) => [name, new Set(node.dependsOn)]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      const cycle = [...remaining]
        .map(([name, dependencies]) => `  ${name} -> ${[...dependencies].sort().join(", ")}`)
        .join("\n");
      throw new Error(
        `Cannot order the workspace build: dependency cycle among @pome-sh packages.\n${cycle}`,
      );
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
    for (const dependencies of remaining.values()) {
      for (const name of ready) dependencies.delete(name);
    }
  }
  return ordered;
}

const nodes = loadGraph();
const order = topoSort(nodes).filter((name) => nodes.get(name).hasBuild);

if (order.length === 0) {
  throw new Error("No workspace package declares a `build` script — nothing to build.");
}

console.log(`Building ${order.length} workspace package(s) in dependency order:`);
for (const [index, name] of order.entries()) console.log(`  ${index + 1}. ${name}`);

for (const name of order) {
  console.log(`\n=== npm run build -w ${name}`);
  const result = spawnSync("npm", ["run", "build", "-w", name], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\nBuild failed in ${name} (exit ${result.status ?? "signal"}).`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nWorkspace build complete (${order.length} package(s)).`);
