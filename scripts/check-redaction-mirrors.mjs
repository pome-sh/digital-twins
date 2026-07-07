// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// F-713: the old canonical (cli/src/recorder/redaction.ts) and the
// adapter-claude-sdk mirror are deleted — both consume redaction from
// @pome-sh/sdk (packages/sdk/src/redaction.ts, the engine implementation).
// The remaining per-twin mirrors stay byte-locked to each other until their
// engine ports (F-682 github, F-684 stripe) delete them.
const canonical = "packages/twin-github/src/redaction.ts";
const mirrors = [
  "packages/twin-stripe/src/redaction.ts",
];

const canonicalText = await readFile(resolve(root, canonical), "utf8");
const mismatches = [];

for (const mirror of mirrors) {
  const mirrorText = await readFile(resolve(root, mirror), "utf8");
  if (mirrorText !== canonicalText) mismatches.push(mirror);
}

if (mismatches.length > 0) {
  throw new Error(
    `Redaction mirrors must match ${canonical} byte-for-byte:\n${mismatches
      .map((path) => `  - ${path}`)
      .join("\n")}`,
  );
}

console.log(`Verified ${mirrors.length + 1} byte-identical redaction mirrors.`);
