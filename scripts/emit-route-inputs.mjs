#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — publish each twin's route input surface as a committed artifact.
//
// pome-cloud's declared-fidelity lane compares what a vendor declares it
// accepts against what our twin accepts. It reads this repo through the
// `POME_TWIN_SRC` checkout seam it already has (the repo is public, so no
// credential is involved), so the twin side has to be a FILE — a lane that has
// to boot five SQLite-backed twins to learn their parameter names would not run
// daily, and one that reads TypeScript with a regex would be wrong.
//
// The artifact is DERIVED, never edited:
//
//   npm run emit:route-inputs           # rewrite packages/twin-*/route-inputs.json
//   npm run gate:route-inputs           # --check: fail if any file is stale
//
// `--check` is what makes the derivation load-bearing. Without it the JSON is
// just another hand-maintained list of parameter names, which is exactly the
// second source of truth this ticket exists to not create.
//
// Reads the BUILT output (`packages/twin-*/dist/route-inputs.js`), not the
// TypeScript, so it needs `npm run build` first — that is also what CI does,
// and it means the artifact reflects the code that actually ships.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

/**
 * Per twin: which built module exports the declarations, and under what name.
 *
 * Explicit rather than discovered, because a MISSING entry has to be a failure.
 * A discovery walk that finds four twins where there are five publishes four
 * artifacts and exits 0, and the fifth twin's 1,130 vendor inputs keep reporting
 * `not-compared` with nothing anywhere saying why. The list is cross-checked
 * against `config/first-party-twins.json` below, so adding a twin without
 * adding it here fails.
 */
const TWINS = [
  { twin: "github", exportName: "GITHUB_ROUTE_INPUTS" },
  { twin: "stripe", exportName: "STRIPE_ROUTE_INPUTS" },
  { twin: "slack", exportName: "SLACK_ROUTE_INPUTS" },
  { twin: "gmail", exportName: "GMAIL_ROUTE_INPUTS" },
  {
    twin: "linear",
    exportName: "LINEAR_ROUTE_INPUTS",
    // twin-linear's API layer is GraphQL: its operation ARGUMENTS come from the
    // executable schema it serves, not from an HTTP route declaration. Both
    // halves publish through this one artifact so pome-cloud has one seam for
    // five twins rather than four plus a bespoke fixture of its own (F-1173).
    graphql: {
      module: "dist/src/graphql/argument-surface.js",
      exportName: "linearGraphqlArgumentSurfaces",
    },
  },
];

async function loadSdk() {
  const sdk = join(ROOT, "packages/sdk/dist/route-inputs.js");
  if (!existsSync(sdk)) {
    console.error(
      `\n${rel(sdk)} does not exist. Run \`npm run build\` first — this script reads built output ` +
        `so the artifact reflects what ships.\n`
    );
    process.exit(1);
  }
  return import(pathToFileURL(sdk).href);
}

const rel = (path) => path.replace(`${ROOT}/`, "");

function assertTwinListComplete() {
  const configured = JSON.parse(
    readFileSync(join(ROOT, "config/first-party-twins.json"), "utf8")
  );
  const names = Array.isArray(configured) ? configured : configured.twins;
  const expected = [...names].sort();
  const listed = TWINS.map((entry) => entry.twin).sort();
  if (JSON.stringify(expected) !== JSON.stringify(listed)) {
    console.error(
      `\nTWINS in ${rel(join(ROOT, "scripts/emit-route-inputs.mjs"))} does not match ` +
        `config/first-party-twins.json:\n  configured: ${expected.join(", ")}\n  listed:     ${listed.join(", ")}\n\n` +
        "A twin missing here publishes no input surface, and pome-cloud's lane keeps reporting\n" +
        "`not-compared` for it with nothing saying why.\n"
    );
    process.exit(1);
  }
}

async function artifactFor(sdk, entry) {
  const packageDir = join(ROOT, "packages", `twin-${entry.twin}`);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const modulePath = join(packageDir, "dist/src/route-inputs.js");
  if (!existsSync(modulePath)) {
    console.error(`\n${rel(modulePath)} does not exist. Run \`npm run build\` first.\n`);
    process.exit(1);
  }
  const module = await import(pathToFileURL(modulePath).href);
  const declarations = module[entry.exportName];
  if (!Array.isArray(declarations) || declarations.length === 0) {
    console.error(
      `\n${rel(modulePath)} exports no usable \`${entry.exportName}\`. It must be the array of every ` +
        `route declaration the twin registers.\n`
    );
    process.exit(1);
  }

  const source = [`packages/twin-${entry.twin}/src/route-inputs.ts`];
  let graphql;
  if (entry.graphql) {
    const graphqlPath = join(packageDir, entry.graphql.module);
    if (!existsSync(graphqlPath)) {
      console.error(`\n${rel(graphqlPath)} does not exist. Run \`npm run build\` first.\n`);
      process.exit(1);
    }
    const graphqlModule = await import(pathToFileURL(graphqlPath).href);
    const project = graphqlModule[entry.graphql.exportName];
    if (typeof project !== "function") {
      console.error(`\n${rel(graphqlPath)} exports no \`${entry.graphql.exportName}()\`.\n`);
      process.exit(1);
    }
    graphql = project();
    source.push(`packages/twin-${entry.twin}/src/graphql/argument-surface.ts`);
  }

  return sdk.buildRouteInputArtifact({
    twin: entry.twin,
    package: manifest.name,
    generatedBy: "npm run emit:route-inputs",
    source,
    declarations,
    ...(graphql ? { graphql } : {}),
  });
}

const sdk = await loadSdk();
assertTwinListComplete();

const stale = [];
let totalSurfaces = 0;
let totalInputs = 0;

for (const entry of TWINS) {
  const artifact = await artifactFor(sdk, entry);
  const target = join(ROOT, "packages", `twin-${entry.twin}`, "route-inputs.json");
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  totalSurfaces += artifact.surface_count;
  totalInputs += artifact.input_count;

  if (CHECK) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current !== serialized) stale.push(rel(target));
    continue;
  }
  writeFileSync(target, serialized);
  console.log(
    `${rel(target)}: ${artifact.surface_count} surface(s), ${artifact.input_count} declared input(s)`
  );
}

if (CHECK && stale.length > 0) {
  console.error(
    `\n${stale.length} route-input artifact(s) do not match the declarations they are derived from:\n`
  );
  for (const path of stale) console.error(`  ${path}`);
  console.error(
    "\nRun `npm run build && npm run emit:route-inputs` and commit the result. Never hand-edit\n" +
      "these files: pome-cloud compares vendor-declared inputs against them, and an artifact\n" +
      "edited by hand reports drift that is not real — which is worse than reporting nothing.\n"
  );
  process.exit(1);
}

console.log(
  `emit-route-inputs${CHECK ? " --check" : ""}: OK — ${TWINS.length} twins, ` +
    `${totalSurfaces} surfaces, ${totalInputs} declared inputs.`
);
