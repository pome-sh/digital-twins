// SPDX-License-Identifier: Apache-2.0
//
// The rule registry. Static imports rather than a directory glob, for two
// reasons: a glob makes every rule file an implicit entry point that `knip`
// cannot follow, and a rule that fails to load is a rule that silently stopped
// running — an import error here is a hard failure at startup, where a glob
// would just find one fewer file. `findUnregisteredRules` in the runner closes
// the other direction: a rule module missing from this list.
//
// The two rules that parse TypeScript are DEFERRED rather than imported. They
// `import ts from "typescript"`, a devDependency, and ESM resolves a static
// import at module load — before the runner gets to decide anything. So a static
// import here would make `npm run lint -- --offline` die with
// ERR_MODULE_NOT_FOUND in CI's always-on block, which runs before `npm ci`,
// taking every other rule down with it. `needsInstall` has to gate the module
// LOAD, not just the call.
//
// Order is run order, cheapest first, so a local `npm run lint` fails fast on
// the obvious things before the import-graph walks and the TypeScript AST rules.

import barrels from "./rules/barrels.mjs";
import bundledDeps from "./rules/bundled-deps.mjs";
import copyMarkers from "./rules/copy-markers.mjs";
import fileSize from "./rules/file-size.mjs";
import firstPartyTwins from "./rules/first-party-twins.mjs";
import legacyMarkers from "./rules/legacy-markers.mjs";
import noCatch from "./rules/no-catch.mjs";
import noEval from "./rules/no-eval.mjs";
import noNative from "./rules/no-native.mjs";
import parentVocab from "./rules/parent-vocab.mjs";
import routeInputs from "./rules/route-inputs.mjs";
import skillManifest from "./rules/skill-manifest.mjs";
import taskClass from "./rules/task-class.mjs";
import taskFormatDoc from "./rules/task-format-doc.mjs";
import twinChunks from "./rules/twin-chunks.mjs";
import twinLeaves from "./rules/twin-leaves.mjs";
import workspacePins from "./rules/workspace-pins.mjs";

/**
 * A rule whose module must not be loaded until the runner knows it can be.
 *
 * `name` and `describe` are restated here because `--list` and the `--offline`
 * skip line have to name the rule without loading it. The loaded module is
 * checked against them, so the two cannot drift apart silently.
 */
function deferred({ name, describe, load }) {
  return {
    name,
    describe,
    needsInstall: true,
    async check(ctx) {
      const rule = (await load()).default;
      if (rule.name !== name) {
        throw new Error(
          `registry calls this rule "${name}" but the module calls itself "${rule.name}" — ` +
            `the deferred entry and its module have drifted apart.`,
        );
      }
      return rule.check(ctx);
    },
  };
}

const importMetaMain = deferred({
  name: "import-meta-main",
  describe: "no bare `import.meta.main`, and every entry guard realpaths both sides",
  load: () => import("./rules/import-meta-main.mjs"),
});

const exampleIsolation = deferred({
  name: "example-isolation",
  describe: "every bundled SDK example sets both `tools` and `settingSources` on `query()`",
  load: () => import("./rules/example-isolation.mjs"),
});

export const RULES = [
  // Manifests and single known files: no tree walk at all.
  barrels,
  bundledDeps,
  workspacePins,
  skillManifest,
  taskFormatDoc,
  firstPartyTwins,
  // Line scans over a subtree.
  copyMarkers,
  fileSize,
  legacyMarkers,
  parentVocab,
  taskClass,
  noEval,
  noCatch,
  // Static import-graph walks.
  twinChunks,
  twinLeaves,
  routeInputs,
  // TypeScript AST walks and lockfile inspection — need an installed tree.
  importMetaMain,
  exampleIsolation,
  noNative,
];
