// SPDX-License-Identifier: Apache-2.0
//
// Emits src/contract/manifest-schema.json from the zod manifest schema,
// following the emit-trace-contract.mjs pattern: default mode writes the file,
// --check fails if the committed file is missing or stale. The committed file is
// what pome.sh/schemas/v1/pome.json serves, so a drift here is a drift in a
// published schema.
//
// Imports the TS source directly — node >= 23.6 strips types natively, and
// src/contract/manifest.ts deliberately has no relative imports (only "zod"), so
// no build is required. That matters: ci.yml runs `--check` in its cheap gate
// block, before anything is built.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const check = args.includes("--check");
const outPath = resolve(
  outIdx >= 0 ? args[outIdx + 1] : join(packageRoot, "src/contract/manifest-schema.json"),
);

const { buildManifestJsonSchema } = await import("../src/contract/manifest.ts");

const body = `${JSON.stringify(buildManifestJsonSchema(), null, 2)}\n`;

if (check) {
  if (!existsSync(outPath)) {
    throw new Error(`${relative(packageRoot, outPath)} does not exist. Run emit:manifest-schema.`);
  }
  const existing = readFileSync(outPath, "utf8");
  if (existing !== body) {
    throw new Error(`${relative(packageRoot, outPath)} is stale. Run emit:manifest-schema.`);
  }
} else {
  writeFileSync(outPath, body);
}

console.log(relative(packageRoot, outPath));
