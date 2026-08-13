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
// images, the black-box contract suite, the wire enums, workflow path
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
  "cli/src/contract/sessions.ts MOUNTED_TWINS",
  quotedArray("cli/src/contract/sessions.ts", "MOUNTED_TWINS"),
);
compare(
  "packages/wire/src/recorder-events.ts KNOWN_TWIN_IDS",
  quotedArray("packages/wire/src/recorder-events.ts", "KNOWN_TWIN_IDS"),
);
compare(
  "cli/src/twin/registry.ts TWIN_NAME_LIST",
  quotedArray("cli/src/twin/registry.ts", "TWIN_NAME_LIST"),
);
// F-1308 — `@pome-sh/checks` carries every twin's grading vocabulary to
// pome-cloud, and its barrel names the five twins explicitly (five `export`
// blocks and a keyed `TWIN_CHECKS` record; there is no way to derive them, since
// each twin's array has a different element type). A sixth twin missing here
// does not fail to compile and does not fail any twin's own contract suite — it
// produces a criterion that silently never binds, which is the exact failure
// this package exists to prevent.
compare(
  "packages/checks/src/index.ts CHECKS_TWIN_NAMES",
  quotedArray("packages/checks/src/index.ts", "CHECKS_TWIN_NAMES"),
);
// F-1526 — `@pome-sh/sandbox-domains` carries the other half to the same
// consumer: the in-process domain runtime `lib/twin-state.ts` boots. Same seam,
// same failure shape as the line above and one step worse — a sixth twin missing
// here compiles, and its criteria do not merely fail to bind, they bind against
// a vocabulary whose runtime pome-cloud cannot construct at all. Both arrays are
// checked because the two packages are the two legs of `checks-package-drift`: a
// twin present in one and absent from the other is precisely the drift that gate
// exists to catch, caught here a repository earlier.
compare(
  "packages/sandbox-domains/src/index.ts SANDBOX_DOMAIN_NAMES",
  quotedArray("packages/sandbox-domains/src/index.ts", "SANDBOX_DOMAIN_NAMES"),
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
// there is no registration seam here to drift-check.

// The twins are bundled into the CLI by tsup (`noExternal: [/^@pome-sh\//]`), so
// they are devDependencies of cli, not runtime deps, and `bundleDependencies` is
// gone. The devDependency list is still a registration seam: a twin missing from
// it would not install, and its registry entry's `import()` would not resolve.
const cliPackage = JSON.parse(read("cli/package.json"));
compare(
  "cli/package.json devDependencies",
  Object.keys(cliPackage.devDependencies)
    .filter((name) => name.startsWith("@pome-sh/twin-"))
    .map((name) => name.slice("@pome-sh/twin-".length)),
);

// package.json's `build` script used to hand-name every twin
// (`npm run build -w @pome-sh/twin-x && ...`), which was itself a drift-prone
// registration seam. scripts/build.mjs replaced it with a topological sort
// over the workspace's own dependency graph (`npm query .workspace`) — it
// enumerates every workspace member with a `build` script and orders them by
// their real `@pome-sh/*` edges, naming no package. A twin missing from the
// build is no longer expressible: it would have to be missing from the
// workspace entirely, which is a different failure this script cannot see
// and don't need to — `npm query .workspace` would already refuse to resolve.

for (const workflow of [
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
