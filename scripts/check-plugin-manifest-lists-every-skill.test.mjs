#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-plugin-manifest-lists-every-skill.mjs` (F-1226).
//
// Case 2 is the reason this file exists: the drift the gate is built for is a
// NEW skill nobody adds to the manifest, and a gate that only checked "every
// declared path exists" would be green on exactly that — the manifest stays
// internally consistent while the seventh skill quietly falls out of the
// installer's select-all row. Both directions are asserted, and case 4 pins the
// real repo so the shipped manifest cannot be the thing that is wrong.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./check-plugin-manifest-lists-every-skill.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Build a throwaway repo: skill dirs on disk + whatever the manifest claims. */
function fixture(skillDirs, declared) {
  const root = mkdtempSync(join(tmpdir(), "plugin-manifest-"));
  for (const name of skillDirs) {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
  }
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "pome-coach", skills: declared }, null, 2),
  );
  return root;
}

let failures = 0;
async function expectGate(name, root, expected) {
  let problems;
  try {
    ({ problems } = await check(root));
  } catch (err) {
    problems = [String(err.message)];
  }
  const got = problems.length === 0 ? "green" : "red";
  if (got !== expected) {
    failures += 1;
    console.error(`✗ ${name}\n  expected ${expected}, got ${got}\n${problems.join("\n")}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

await expectGate(
  "1. manifest lists exactly the skills on disk",
  fixture(["pome", "pome-run-task"], ["./skills/pome", "./skills/pome-run-task"]),
  "green",
);

await expectGate(
  "2. a new skill nobody added to the manifest reds the gate",
  fixture(["pome", "pome-run-task", "pome-new"], ["./skills/pome", "./skills/pome-run-task"]),
  "red",
);

await expectGate(
  "3. a manifest path whose directory is gone reds the gate",
  fixture(["pome"], ["./skills/pome", "./skills/pome-renamed-away"]),
  "red",
);

await expectGate(
  "4. a directory with no SKILL.md is not a skill and is not required",
  (() => {
    const root = fixture(["pome"], ["./skills/pome"]);
    mkdirSync(join(root, "skills/_shared"), { recursive: true });
    writeFileSync(join(root, "skills/_shared/notes.md"), "not a skill\n");
    return root;
  })(),
  "green",
);

await expectGate("5. the real repo's manifest is complete", REPO_ROOT, "green");

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll cases passed.`);
