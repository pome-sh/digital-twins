// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_SHA256 = new Map([
  // F-713: the twin-core engine, vendored so the engine-based twin tarballs'
  // `workspace:*` sdk dep resolves via the same exact-version hoist mechanism
  // as @pome-sh/shared-types (dependencies + overrides + bundleDependencies
  // in package.json). Refresh via: node scripts/pack-publishable.mjs --vendor-cli
  // (repo root), then update this hash.
  ["vendor/pome-sh-sdk-0.2.0.tgz", "d1b754f3f13485d925fb5389ca04a01575ae81d978ebcc8d3a633e33a927f1a8"],
  ["vendor/pome-sh-shared-types-0.6.0.tgz", "d13f4fa71a292ec6bc5cde9dac449c48c5f47bef13dc69c78c5f24cecd86c446"],
  ["vendor/pome-sh-twin-github-0.1.0.tgz", "f8b92f423db633552a6525690c922b9cc3467c222c68fca814cf86d395f18a94"],
  ["vendor/pome-sh-twin-slack-0.1.0.tgz", "80f1a763f426bb44c431217958c8bb79d805291608e138dbca31cd786b53cfd6"],
  ["vendor/pome-sh-twin-stripe-0.2.0.tgz", "bed2fdc0d6c92921079d21400fb60b0569897a124cf48e52fd9b0e1fbde76e5f"],
]);

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const declared = Object.values({
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
  ...(pkg.overrides ?? {}),
})
  .filter((value) => typeof value === "string" && value.startsWith("file:./vendor/"))
  .map((value) => value.slice("file:./".length));

const missingFromManifest = [...EXPECTED_SHA256.keys()].filter((path) => !declared.includes(path));
if (missingFromManifest.length > 0) {
  throw new Error(`Vendor manifest no longer references expected tarballs: ${missingFromManifest.join(", ")}`);
}

const undeclared = declared.filter((path) => !EXPECTED_SHA256.has(path));
if (undeclared.length > 0) {
  throw new Error(`Vendor tarballs must be added to scripts/verify-vendor.mjs: ${undeclared.join(", ")}`);
}

for (const [path, expected] of EXPECTED_SHA256) {
  const bytes = await readFile(resolve(root, path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Vendor checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

console.log(`Verified ${EXPECTED_SHA256.size} vendored tarballs.`);
