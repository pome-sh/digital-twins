#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `lint-parent-vocab.mjs` (F-1200).
//
// Case 2 is the reason this file exists: the first version of the gate stripped
// string literals before scanning, so `{ "parent_id": null }` emitted the
// forbidden field with the gate still green. A gate that cannot fail is worse
// than no gate, because it reads as coverage — the same lesson F-1201 learned
// about the trace contract. Each case builds a throwaway source tree and runs
// the real script against it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "lint-parent-vocab.mjs");

function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), "parent-vocab-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

let failures = 0;
function check(name, { files, expect }) {
  const { code, out } = runAgainst(files);
  const got = code === 0 ? "green" : "red";
  if (got !== expect) {
    failures += 1;
    console.error(`✗ ${name}\n  expected ${expect}, got ${got}\n${out.replace(/^/gm, "    ")}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const EMITTER = "packages/twin-x/src/emit.ts";

check("1. a bare parent_id key is a violation", {
  files: { [EMITTER]: `export const row = { parent_id: null };\n` },
  expect: "red",
});

check("2. a QUOTED parent_id key is a violation (the review finding)", {
  files: { [EMITTER]: `export const row = { "parent_id": null };\n` },
  expect: "red",
});

check("3. a computed parent_id key is a violation", {
  files: { [EMITTER]: `export const row = { ["parent_id"]: null };\n` },
  expect: "red",
});

check("4. a single-quoted key is a violation", {
  files: { [EMITTER]: `export const row = { 'parent_id': null };\n` },
  expect: "red",
});

check("5. a line comment mentioning parent_id is fine", {
  files: { [EMITTER]: `// parent_id used to mean four things\nexport const row = {};\n` },
  expect: "green",
});

check("6. a block comment mentioning parent_id is fine", {
  files: { [EMITTER]: `/* parent_id\n * still mentioned here\n */\nexport const row = {};\n` },
  expect: "green",
});

check("7. the canonical spellings are not false positives", {
  files: {
    [EMITTER]:
      `export const row = { parent_event_id: null, parent_span_id: null, ` +
      `parent_tool_use_id: "t", causing_tool_use_id: null };\n`,
  },
  expect: "green",
});

check("8. an allowlisted reader may name the legacy key", {
  files: {
    "packages/wire/src/recorder-events.ts": `export const s = { parent_id: 1 };\n`,
  },
  expect: "green",
});

check("9. the allowlist covers a whole directory when it ends in /", {
  files: {
    "packages/twin-linear/src/domain/issues.ts": `const sql = "SELECT parent_id FROM issues";\n`,
    "packages/twin-linear/src/db.ts": `const ddl = "parent_id TEXT";\n`,
  },
  expect: "green",
});

check("10. the violation names the file and the line", {
  files: { [EMITTER]: `const a = 1;\nexport const row = { parent_id: null };\n` },
  expect: "red",
});

const { out } = runAgainst({ [EMITTER]: `const a = 1;\nexport const row = { parent_id: null };\n` });
if (!out.includes(`${EMITTER}:2:`)) {
  failures += 1;
  console.error(`✗ 10b. expected the report to name ${EMITTER}:2, got:\n${out}`);
} else {
  console.log("✓ 10b. the report names the exact line");
}

if (failures > 0) {
  console.error(`\n${failures} parent-vocab gate regression(s) failed.`);
  process.exit(1);
}
console.log("\n✅ parent-vocab gate regression tests passed");
