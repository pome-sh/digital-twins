#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for skill-manifest. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

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
    name: "a manifest with no `skills` array reds the rule",
    files: {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "pome-coach" }),
      "skills/pome/SKILL.md": "---\nname: pome\n---\n",
    },
    expect: "red",
    contains: 'has no "skills" array',
  },
]);
