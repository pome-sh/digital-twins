// SPDX-License-Identifier: Apache-2.0
//
// Every shipped skill must be declared in the plugin manifest.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_PATH = ".claude-plugin/plugin.json";

export function discoverSkillDirs(repoRoot) {
  const skillsDir = join(repoRoot, "skills");
  const found = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      statSync(join(skillsDir, entry.name, "SKILL.md"));
    } catch {
      continue;
    }
    found.push(`./skills/${entry.name}`);
  }
  return found.sort();
}

export function diffSkillLists(onDisk, declared) {
  const declaredSet = new Set(declared);
  const onDiskSet = new Set(onDisk);
  return {
    missing: onDisk.filter((skill) => !declaredSet.has(skill)),
    stale: declared.filter((skill) => !onDiskSet.has(skill)),
  };
}

export default {
  name: "skill-manifest",
  describe: "the plugin manifest lists every skill under skills/",
  check(ctx) {
    const manifest = ctx.json(MANIFEST_PATH);
    if (!Array.isArray(manifest.skills)) {
      return {
        violations: [
          `${MANIFEST_PATH} has no "skills" array — the installer then renders a flat list with ` +
            `no select-all row.`,
        ],
      };
    }

    const onDisk = discoverSkillDirs(ctx.root);
    const { missing, stale } = diffSkillLists(onDisk, [...manifest.skills].sort());

    const violations = [];
    if (missing.length > 0) {
      violations.push(
        `not listed in ${MANIFEST_PATH} (they land in the installer's "Other" bucket, outside the ` +
          `select-all row):\n` + missing.map((skill) => `  - ${skill}`).join("\n"),
      );
    }
    if (stale.length > 0) {
      violations.push(
        `listed in ${MANIFEST_PATH} but absent from skills/ (renamed or deleted?):\n` +
          stale.map((skill) => `  - ${skill}`).join("\n"),
      );
    }
    return { violations, summary: `all ${onDisk.length} skills listed, so the installer renders one select-all row` };
  },
};
