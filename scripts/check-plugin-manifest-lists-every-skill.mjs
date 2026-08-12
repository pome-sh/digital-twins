// SPDX-License-Identifier: Apache-2.0
//
// F-1226 — `.claude-plugin/plugin.json` must list every skill under `skills/`.
//
// What the manifest buys: the `skills` CLI reads it (README → "Plugin Manifest
// Discovery") and groups the skills it names under one collapsible row. That
// row carries its own radio, so `npx skills add pome-sh/digital-twins` opens
// with the cursor already on "Pome Coach" and one space selects all six. The
// flat list it renders without a manifest starts with nothing ticked and the
// cursor on the first skill, which is how F-1226 was filed: a user takes the
// screen literally, installs one skill, and the coach dead-ends routing into a
// skill that is not there.
//
// The failure this gate exists to stop: a seventh skill is added under
// `skills/`, nobody adds it here, and it silently lands in the installer's
// "Other" bucket — outside the select-all row, which is precisely the state we
// were fixing. Nothing else notices, because both files are individually valid
// and the install still succeeds.
//
// Ordering is not checked. Presence is.
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories under `skills/` that are a skill: they contain a SKILL.md. */
export async function discoverSkillDirs(repoRoot) {
  const skillsDir = join(repoRoot, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hasSkillMd = await stat(join(skillsDir, entry.name, "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    if (hasSkillMd) found.push(`./skills/${entry.name}`);
  }
  return found.sort();
}

/** The `skills` array as the manifest declares it, normalized for comparison. */
export async function readManifestSkills(repoRoot) {
  const path = join(repoRoot, ".claude-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(manifest.skills)) {
    throw new Error(
      `${relative(repoRoot, path)} has no "skills" array — the installer then ` +
        `renders a flat list with no select-all row.`,
    );
  }
  return [...manifest.skills].sort();
}

/** Returns the two directions of drift. Exported for the regression test. */
export function diffSkillLists(onDisk, declared) {
  const declaredSet = new Set(declared);
  const onDiskSet = new Set(onDisk);
  return {
    missing: onDisk.filter((s) => !declaredSet.has(s)),
    stale: declared.filter((s) => !onDiskSet.has(s)),
  };
}

export async function check(repoRoot) {
  const onDisk = await discoverSkillDirs(repoRoot);
  const declared = await readManifestSkills(repoRoot);
  const { missing, stale } = diffSkillLists(onDisk, declared);

  const problems = [];
  if (missing.length > 0) {
    problems.push(
      `not listed in .claude-plugin/plugin.json (they land in the installer's ` +
        `"Other" bucket, outside the select-all row):\n` +
        missing.map((s) => `  - ${s}`).join("\n"),
    );
  }
  if (stale.length > 0) {
    problems.push(
      `listed in .claude-plugin/plugin.json but absent from skills/ (renamed or ` +
        `deleted?):\n` + stale.map((s) => `  - ${s}`).join("\n"),
    );
  }
  return { onDisk, declared, problems };
}

// Run as a script, not when imported by the regression test. Realpath'd on
// both sides — a bare `resolve()` of argv[1] (with no realpath) misses
// through a symlinked checkout (a worktree, or macOS's symlinked `/tmp`) in
// the same silent shape F-1488 found in nine sibling gates, and a guard miss
// while invoked as this file throws rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("check-plugin-manifest-lists-every-skill.mjs")) {
  throw new Error(
    `check-plugin-manifest-lists-every-skill.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`
  );
}

if (invokedDirectly) {
  const { onDisk, problems } = await check(root);
  if (problems.length > 0) {
    throw new Error(`Plugin-manifest gate failed. ${problems.join("\n\n")}`);
  }
  console.log(
    `Plugin-manifest gate passed — .claude-plugin/plugin.json lists all ${onDisk.length} skills, ` +
      `so the installer renders one select-all row.`,
  );
}
