#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `lint-task-class.mjs` (F-1302).
//
// Case 5 is why this file exists rather than a "it went green once" note. The
// gate's whole job is to refuse a task that declares no class — and the cheapest
// way for it to stop doing that job is for the WALK to stop finding the file,
// not for the check to break. A gate that scans nothing prints the same success
// line as a gate that scanned everything, which is F-989 restated. So the suite
// asserts the zero-file case is RED, and that a task nested one level deeper
// than `tasks/` is still seen.
//
// Each case builds a throwaway corpus and runs the real script against it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "lint-task-class.mjs");

function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), "task-class-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

let failures = 0;
function check(name, { files, expect, contains }) {
  const { code, out } = runAgainst(files);
  const got = code === 0 ? "green" : "red";
  const wrong = got !== expect || (contains !== undefined && !out.includes(contains));
  if (wrong) {
    failures += 1;
    console.error(
      `✗ ${name}\n  expected ${expect}${contains ? ` containing ${JSON.stringify(contains)}` : ""}, ` +
        `got ${got}\n${out.replace(/^/gm, "    ")}`,
    );
  } else {
    console.log(`✓ ${name}`);
  }
}

const task = (cls) =>
  [
    "# A task",
    "",
    "## Prompt",
    "",
    "Do the thing.",
    "",
    "## Success Criteria",
    "",
    "- [code] Issue #1 in `acme/api` has the `bug` label applied",
    "",
    "## Config",
    "",
    "```yaml",
    "twins: [github]",
    ...(cls === null ? [] : [`class: ${cls}`]),
    "timeout: 60",
    "passThreshold: 100",
    "```",
    "",
  ].join("\n");

check("1. every task declaring a valid class is green", {
  files: {
    "cli/tasks/01-a.md": task("conformance"),
    "cli/tasks/02-b.md": task("restraint"),
    "examples/agent/tasks/03-c.md": task("adversarial"),
  },
  expect: "green",
  contains: "1 conformance, 1 restraint, 1 adversarial",
});

check("2. a task with no `class:` line is a violation, and is NAMED", {
  files: {
    "cli/tasks/01-a.md": task("conformance"),
    "cli/tasks/02-unlabelled.md": task(null),
  },
  expect: "red",
  contains: "cli/tasks/02-unlabelled.md",
});

check("3. a class outside the vocabulary is a violation", {
  files: { "cli/tasks/01-a.md": task("smoke") },
  expect: "red",
  contains: "class: smoke",
});

check("4. a task with no `## Config` block at all is a violation", {
  files: {
    "cli/tasks/01-a.md": "# A task\n\n## Prompt\n\nDo the thing.\n",
  },
  expect: "red",
  contains: "cli/tasks/01-a.md",
});

// The failure mode a passing gate cannot distinguish itself from.
check("5. a corpus that resolves to zero task files is RED, not green", {
  files: { "README.md": "# not a corpus\n" },
  expect: "red",
  contains: "Refusing to pass a zero-file scan",
});

// The walk, asserted rather than assumed. `examples/<agent>/tasks/<file>.md` is
// two levels down; a walker that only looked at direct children of the corpus
// root would silently exempt every example task.
check("6. an example task two levels below the corpus root is seen", {
  files: {
    "cli/tasks/01-a.md": task("conformance"),
    "examples/agent/tasks/01-unlabelled.md": task(null),
  },
  expect: "red",
  contains: "examples/agent/tasks/01-unlabelled.md",
});

// F-1300's walker gap, asserted from the other side: a task nested UNDER a
// `tasks/` directory must still be seen. `collectTaskFiles` reads `.md` at
// depth 0 or in any directory literally named `tasks`, so a `tasks/<topic>/`
// subdirectory is a live way to leave the corpus.
check("7. a task in a subdirectory of `tasks/` is seen", {
  files: {
    "cli/tasks/01-a.md": task("conformance"),
    "cli/tasks/github/01-unlabelled.md": task(null),
  },
  expect: "red",
  contains: "cli/tasks/github/01-unlabelled.md",
});

// A README sitting beside the tasks is not a task. Counting it would inflate a
// denominator pome-cloud pins, and it carries no criteria to classify.
check("8. a README beside the tasks is not counted as a task", {
  files: {
    "examples/agent/tasks/01-a.md": task("conformance"),
    "examples/agent/README.md": "# how to run this example\n",
    "examples/agent/VERIFICATION.md": "# verification\n",
  },
  expect: "green",
  contains: "1 task(s)",
});

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nlint-task-class regression suite passed.");
