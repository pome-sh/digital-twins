// SPDX-License-Identifier: Apache-2.0
//
// Canonical first-party registration drift gate. First-party twins must be
// explicit at operational seams (contracts, bundles, images), but those
// explicit arrays are easy to update incompletely. This check compares every
// registration with config/first-party-twins.json and fails loudly.
//
// The CLI's own registration is no longer a hand-maintained array: `TwinName` is
// derived from `TWIN_NAME_LIST` and `TWIN_REGISTRY` is a
// `Record<TwinName, TwinEntry>`, so a missing CLI entry is a compile error and
// the per-entry values are asserted by cli/test/unit/twin/registry.test.ts.
// `TWIN_NAME_LIST` itself is still compared here — that list is what the type
// is derived FROM, so nothing inside the CLI can catch it drifting from the
// canonical set. The seams below live outside the type system entirely (twin
// images, the black-box contract suite, shared-types wire enums, workflow path
// filters) and are the reason this script survives.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const canonical = JSON.parse(read("config/first-party-twins.json")).twins;
const expected = [...canonical].sort();
const failures = [];

function compare(label, actual) {
  const sorted = [...new Set(actual)].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected [${expected.join(", ")}], got [${sorted.join(", ")}]`);
  }
}

function quotedArray(path, exportName) {
  const text = read(path);
  const match = text.match(
    new RegExp(`(?:const|export const)\\s+${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\](?:\\s+as const)?`),
  );
  if (!match) throw new Error(`${path}: could not find array ${exportName}`);
  return [...match[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)].map((item) => item[1]);
}

compare(
  "packages/shared-types/src/sessions.ts MOUNTED_TWINS",
  quotedArray("packages/shared-types/src/sessions.ts", "MOUNTED_TWINS"),
);
compare(
  "packages/shared-types/src/recorder-events.ts KNOWN_TWIN_IDS",
  quotedArray("packages/shared-types/src/recorder-events.ts", "KNOWN_TWIN_IDS"),
);
compare(
  "cli/src/twin/registry.ts TWIN_NAME_LIST",
  quotedArray("cli/src/twin/registry.ts", "TWIN_NAME_LIST"),
);

const contractNames = [
  ...read("contract/helpers.mjs").matchAll(/\{\s*name:\s*"([a-z][a-z0-9-]*)",\s*pkg:\s*"packages\/twin-/g),
].map((match) => match[1]);
compare("contract/helpers.mjs ALL_TWINS", contractNames);
const cliContractNames = [
  ...read("contract/cli-start.test.mjs").matchAll(/cliStart\("([a-z][a-z0-9-]*)"/g),
].map((match) => match[1]);
compare("contract/cli-start.test.mjs TWINS", cliContractNames);

// Twin-image matrix is dynamic on PRs (`detect-twins`); the canonical full
// set is declared as FIRST_PARTY_TWINS (and mirrored in the detect script's
// `all='[...]'` / `for twin in ...` loop).
const imageText = read(".github/workflows/twin-image.yml");
const imageCanon = imageText.match(/#\s*FIRST_PARTY_TWINS:\s*([^\n]+)/);
const imageAll = imageText.match(/all='\[([^\]]+)\]'/);
const imageLegacy = imageText.match(/twin:\s*\[([^\]]+)\]/);
const imageRaw = imageCanon?.[1] ?? imageAll?.[1] ?? imageLegacy?.[1];
if (!imageRaw) throw new Error(".github/workflows/twin-image.yml: twin matrix not found");
compare(
  ".github/workflows/twin-image.yml matrix",
  imageRaw.split(/[,\s]+/).map((value) => value.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
);

// Docker base-image updates are handled by Renovate, which auto-discovers
// every packages/twin-*/Dockerfile — no per-twin config to keep in sync, so
// there is no registration seam here to drift-check (was .github/dependabot.yml).

const cliPackage = JSON.parse(read("cli/package.json"));
compare(
  "cli/package.json dependencies",
  Object.keys(cliPackage.dependencies)
    .filter((name) => name.startsWith("@pome-sh/twin-"))
    .map((name) => name.slice("@pome-sh/twin-".length)),
);
compare(
  "cli/package.json bundleDependencies",
  cliPackage.bundleDependencies
    .filter((name) => name.startsWith("@pome-sh/twin-"))
    .map((name) => name.slice("@pome-sh/twin-".length)),
);

const rootPackage = JSON.parse(read("package.json"));
for (const twin of canonical) {
  if (!rootPackage.scripts.build.includes(`-w @pome-sh/twin-${twin}`)) {
    failures.push(`package.json build: missing @pome-sh/twin-${twin}`);
  }
}

for (const workflow of [
  ".github/workflows/cli-ci.yml",
  ".github/workflows/twin-image.yml",
  ".github/workflows/agent-trace-overhead-gate.yml",
]) {
  const text = read(workflow);
  for (const twin of canonical) {
    if (!text.includes(`packages/twin-${twin}/**`)) {
      failures.push(`${workflow}: missing packages/twin-${twin}/** path filter`);
    }
  }
}

// The twins are no longer published to npm (they are `private: true`
// workspace members bundled into @pome-sh/cli), so there is no per-twin
// publish artifact or npm-dependency gate left to drift-check here. The
// former sdk-publish.yml / cli-release.yml assertions died with those seams.

const catalogIds = [
  ...read("cli/src/cli/tasks-catalog.ts").matchAll(/^\s{4}id:\s*"([a-z][a-z0-9-]*)",$/gm),
].map((match) => match[1]);
compare("cli/src/cli/tasks-catalog.ts TASK_TWINS", catalogIds);

if (failures.length > 0) {
  console.error("First-party twin registration drift:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`First-party twin registrations agree: ${canonical.join(", ")}`);
