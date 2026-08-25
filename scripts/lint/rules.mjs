// SPDX-License-Identifier: Apache-2.0
//
// The rule registry. Entries may defer their import, because ci.yml's always-on
// block runs before `npm ci` and a static import of a devDependency dies at load.

import barrels from "./rules/barrels.mjs";
import bundledDeps from "./rules/bundled-deps.mjs";
import fileSize from "./rules/file-size.mjs";
import firstPartyTwins from "./rules/first-party-twins.mjs";
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
      if (rule.describe !== describe) {
        throw new Error(
          `the deferred entry for "${name}" describes it differently from its module:\n` +
            `  registry: ${describe}\n` +
            `  module:   ${rule.describe}`,
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
  barrels,
  bundledDeps,
  workspacePins,
  skillManifest,
  taskFormatDoc,
  firstPartyTwins,
  fileSize,
  parentVocab,
  taskClass,
  noEval,
  noCatch,
  twinChunks,
  twinLeaves,
  routeInputs,
  importMetaMain,
  exampleIsolation,
  noNative,
];
