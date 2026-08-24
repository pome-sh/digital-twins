// SPDX-License-Identifier: Apache-2.0
//
// The root `workspaces` field, resolved to its member manifests.
//
// Extracted when a second caller needed it: the `workspace-pins` lint rule
// checks that every `@pome-sh/*` pin resolves to its sibling, and
// `check-example-pins-published.mjs` needs the same sibling-name →
// workspace-version map to know which `agent-examples/*` pins have a sibling to
// compare against. Two hand-rolled copies would be two chances to disagree
// about what a "sibling" is.

import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SCOPE IS THE ROOT `workspaces` FIELD, not a hand-kept list. Every member is
 * both a consumer (its pins are checked) and a sibling (it can be pinned AT),
 * because npm's resolution makes no distinction: `cli` is a workspace member, so
 * a `packages/*` package pinning a stale `@pome-sh/cli` would get a nested
 * registry copy exactly as it would for the sdk. A hardcoded `packages/*` + `cli`
 * pair silently stops covering its subject the moment root grows a glob or the
 * CLI moves directory. An empty result throws rather than reporting a pass over
 * nothing.
 */
export function loadWorkspaceMembers(repoRoot) {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const relativePaths = (root.workspaces ?? []).flatMap((pattern) =>
    globSync(join(pattern, "package.json"), { cwd: repoRoot }),
  );
  if (relativePaths.length === 0) {
    throw new Error(
      `no workspace manifests found under ${repoRoot} for workspaces ${JSON.stringify(root.workspaces)}`,
    );
  }
  return relativePaths.map((relativePath) => ({
    manifest: JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")),
    label: dirname(relativePath),
  }));
}
