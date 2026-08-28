// SPDX-License-Identifier: Apache-2.0
//
// The directories that hold bundled, independently-installed examples.
//
// TWO ROOTS, and the split is a taxonomy rather than a convenience:
//
//   agent-examples/        an AGENT for Pome to grade. Every one is an examinee:
//                          `pome.json` carries a `command`, and `pome run`
//                          launches it against a twin.
//   integration-examples/  a harness that DRIVES Pome from somewhere else. Not
//                          an examinee — `pome.json` deliberately carries no
//                          `command`, because another runner (Braintrust's
//                          `Eval()`, LangSmith's `evaluate()`) owns the loop and
//                          mints the sandboxes itself. A `pome run` pointed at
//                          one would sit watching a sandbox nothing ever called.
//
// Everything else about them is the same, which is why this is one list and not
// two code paths: each carries its own lockfile, installs on its own, sits
// outside the root npm workspace, and is auto-discovered by `readdirSync` rather
// than registered.
//
// WHY A SHARED CONSTANT. Ten separate scanners hard-coded the string
// "agent-examples", and the failure mode when a second root appeared was not a
// red build — it was each scanner quietly covering less than its name claims.
// `example-isolation.mjs` is the only one that refuses to pass on an empty scan;
// the rest would have gone green over an example nothing checked. A root added
// here reaches all of them at once.
//
// `.github/workflows/ci.yml`'s heavy-suite path filter and `knip.json`'s
// workspace globs cannot import this file. They carry the literals, and the
// self-test in `example-roots.test.mjs` is what keeps them in step.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every root that holds independently-installed example packages. */
export const EXAMPLE_ROOTS = ["agent-examples", "integration-examples"];

/**
 * One entry per example across every root, in a stable order.
 *
 * `rel` is the repo-relative path a message should name — an example is
 * identified to a reader by its root as well as its name now that there are
 * two, and "braintrust: FAILED" no longer says where to look.
 */
export function listExamples(repoRoot) {
  const out = [];
  for (const root of EXAMPLE_ROOTS) {
    const dir = join(repoRoot, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!name.isDirectory()) continue;
      if (!existsSync(join(dir, name.name, "package.json"))) continue;
      out.push({ root, name: name.name, rel: `${root}/${name.name}`, dir: join(dir, name.name) });
    }
  }
  return out;
}
