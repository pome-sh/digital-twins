#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case 2 is the reason this table exists: the drift the rule is built for is a
// NEW skill nobody adds to the manifest, and a rule that only checked "every
// declared path exists" would be green on exactly that — the manifest stays
// internally consistent while the new skill quietly falls out of the installer's
// select-all row. Both directions are asserted.

import { defineCases } from "../harness.mjs";

/** A throwaway repo: skill dirs on disk + whatever the manifest claims. */
function fixture(skillDirs, declared, extra = {}) {
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "pome-coach", skills: declared }, null, 2),
    ...extra,
  };
  for (const name of skillDirs) {
    files[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: x\n---\n`;
  }
  return files;
}

defineCases("skill-manifest", [
  {
    name: "manifest lists exactly the skills on disk",
    files: fixture(["pome", "pome-run-task"], ["./skills/pome", "./skills/pome-run-task"]),
    expect: "green",
  },
  {
    name: "a new skill nobody added to the manifest reds the rule",
    files: fixture(["pome", "pome-run-task", "pome-new"], ["./skills/pome", "./skills/pome-run-task"]),
    expect: "red",
    contains: "./skills/pome-new",
  },
  {
    name: "a manifest path whose directory is gone reds the rule",
    files: fixture(["pome"], ["./skills/pome", "./skills/pome-renamed-away"]),
    expect: "red",
    contains: "./skills/pome-renamed-away",
  },
  {
    name: "a directory with no SKILL.md is not a skill and is not required",
    files: fixture(["pome"], ["./skills/pome"], { "skills/_shared/notes.md": "not a skill\n" }),
    expect: "green",
  },
  {
    // A manifest with no `skills` array at all is the state the installer renders
    // as a flat list with nothing ticked — the bug this rule exists to keep fixed.
    name: "a manifest with no `skills` array reds the rule",
    files: {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "pome-coach" }),
      "skills/pome/SKILL.md": "---\nname: pome\n---\n",
    },
    expect: "red",
    contains: 'has no "skills" array',
  },
]);
