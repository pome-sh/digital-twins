// SPDX-License-Identifier: Apache-2.0
//
// Workspace members from the root `workspaces` field, so nothing keeps its own list.

import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
