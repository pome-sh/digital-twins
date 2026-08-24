// SPDX-License-Identifier: Apache-2.0
//
// The rule registry. Static imports rather than a directory glob, for two
// reasons: a glob makes every rule file an implicit entry point that `knip`
// cannot follow, and a rule that fails to load is a rule that silently stopped
// running — an import error here is a hard failure at startup, where a glob
// would just find one fewer file.
//
// Order is run order, cheapest first, so a local `npm run lint` fails fast on
// the obvious things before the import-graph walks and the TypeScript AST rules.

import barrels from "./rules/barrels.mjs";
import bundledDeps from "./rules/bundled-deps.mjs";
import copyMarkers from "./rules/copy-markers.mjs";
import exampleIsolation from "./rules/example-isolation.mjs";
import fileSize from "./rules/file-size.mjs";
import firstPartyTwins from "./rules/first-party-twins.mjs";
import importMetaMain from "./rules/import-meta-main.mjs";
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
