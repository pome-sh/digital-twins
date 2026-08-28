// SPDX-License-Identifier: Apache-2.0
//
// `EXAMPLE_ROOTS` is imported by every scanner that can import it. Two consumers
// CANNOT — `.github/workflows/ci.yml`'s heavy-suite path filter is a shell regex
// and `knip.json` is data — so they carry the literals, and this file is what
// stops those two from lagging a root.
//
// Why that specific pair is worth a test rather than a comment: the failure is
// silent in both cases and it points the wrong way. A root missing from the
// ci.yml filter means a PR that touches only that root is classified
// docs/chore-only and SKIPS the heavy suite — the required check goes green
// having run nothing relevant. A root missing from knip.json means the example's
// entry points are invisible to knip, so its files read as unused rather than as
// unchecked. Neither reds.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { EXAMPLE_ROOTS, listExamples } from "./example-roots.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("EXAMPLE_ROOTS holds the two roots, and the taxonomy is not empty on either side", () => {
  assert.deepEqual(EXAMPLE_ROOTS, ["agent-examples", "integration-examples"]);
  const examples = listExamples(repoRoot);
  for (const root of EXAMPLE_ROOTS) {
    const inRoot = examples.filter((e) => e.root === root);
    assert.ok(
      inRoot.length > 0,
      `${root}/ holds no example package. Either the root was removed (drop it here and from ` +
        `ci.yml + knip.json in the same change) or an example moved out of it and every scanner ` +
        `that walks this list is now covering less than its name claims.`,
    );
  }
});

test("every root is in ci.yml's heavy-suite path filter", () => {
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const filterLine = ci.split("\n").find((line) => line.includes("heavy=true") === false && /\^\(packages\//.test(line));
  assert.ok(filterLine, "could not find the heavy-suite path filter in ci.yml");
  for (const root of EXAMPLE_ROOTS) {
    assert.ok(
      filterLine.includes(`${root}/`),
      `ci.yml's heavy-suite path filter does not list ${root}/ — a PR touching only that root would ` +
        `be classified docs/chore-only and skip the heavy suite entirely, green.`,
    );
  }
});

test("every root has a knip workspace block", () => {
  const knip = JSON.parse(readFileSync(join(repoRoot, "knip.json"), "utf8"));
  for (const root of EXAMPLE_ROOTS) {
    assert.ok(
      knip.workspaces?.[`${root}/*`],
      `knip.json has no "${root}/*" workspace block, so those examples' entry points are invisible ` +
        `to knip and their files read as unused rather than unchecked.`,
    );
  }
});

test("listExamples reports the root with each example, so a message can locate it", () => {
  const examples = listExamples(repoRoot);
  assert.ok(examples.length >= 2);
  for (const example of examples) {
    assert.equal(example.rel, `${example.root}/${example.name}`);
    assert.ok(EXAMPLE_ROOTS.includes(example.root));
  }
  // The braintrust recipe is the reason the second root exists: it is not an
  // examinee, so `pome.json` carries no `command`.
  const braintrust = examples.find((e) => e.name === "braintrust");
  assert.ok(braintrust, "integration-examples/braintrust is missing");
  assert.equal(braintrust.root, "integration-examples");
  const manifest = JSON.parse(readFileSync(join(braintrust.dir, "pome.json"), "utf8"));
  assert.equal(
    manifest.command,
    undefined,
    "integration-examples/braintrust grew a `command`, which would make it an examinee — if that is " +
      "intended it belongs back under agent-examples/.",
  );
});
