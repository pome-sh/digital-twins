#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Breaks the manifest several ways in --manifest-only mode. A gate only ever run
// against a green tree could have been process.exit(0).

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "scripts", "ci", "check-sandbox-domains-tarball.mjs");
const MANIFEST = join(ROOT, "packages", "sandbox-domains", "package.json");
const BACKUP = `${MANIFEST}.test-backup`;

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function runGate() {
  try {
    const output = execFileSync(process.execPath, [GATE, "--manifest-only"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function withMutatedManifest(mutate) {
  copyFileSync(MANIFEST, BACKUP);
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    mutate(manifest);
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    return runGate();
  } finally {
    copyFileSync(BACKUP, MANIFEST);
    execFileSync("rm", ["-f", BACKUP]);
  }
}

console.log("check-sandbox-domains-tarball.mjs — manifest assertions");

const clean = runGate();
check("passes on the real manifest", clean.ok, clean.output);

const privatised = withMutatedManifest((m) => {
  m.private = true;
});
check(
  "fails when the package is privatised",
  !privatised.ok && /private: true/.test(privatised.output),
  privatised.output,
);

const privateAbsent = withMutatedManifest((m) => {
  delete m.private;
});
check(
  "fails when `private` is absent rather than explicitly false",
  !privateAbsent.ok && /must be exactly/.test(privateAbsent.output),
  privateAbsent.output,
);

const pinnedRegistry = withMutatedManifest((m) => {
  m.publishConfig.registry = "https://npm.pkg.github.com";
});
check(
  "fails when publishConfig.registry is pinned",
  !pinnedRegistry.ok && /publishConfig\.registry/.test(pinnedRegistry.output),
  pinnedRegistry.output,
);

const restricted = withMutatedManifest((m) => {
  m.publishConfig.access = "restricted";
});
check(
  "fails when publishConfig.access is not public",
  !restricted.ok && /access/.test(restricted.output),
  restricted.output,
);

const leakedInternal = withMutatedManifest((m) => {
  m.dependencies["@pome-sh/sdk"] = "*";
});
check(
  "fails on a leaked @pome-sh/* runtime dependency",
  !leakedInternal.ok && /@pome-sh\/sdk/.test(leakedInternal.output),
  leakedInternal.output,
);

const leakedPeer = withMutatedManifest((m) => {
  m.peerDependencies["@pome-sh/twin-github"] = "*";
});
check(
  "fails on a leaked @pome-sh/* PEER dependency too",
  !leakedPeer.ok && /peerDependencies/.test(leakedPeer.output),
  leakedPeer.output,
);

const zodNotPeer = withMutatedManifest((m) => {
  delete m.peerDependencies.zod;
  m.dependencies.zod = "^4.4.3";
});
check(
  "fails when zod stops being a peerDependency",
  !zodNotPeer.ok && /peerDependency/.test(zodNotPeer.output),
  zodNotPeer.output,
);

const driftedAnchor = withMutatedManifest((m) => {
  m.dependencies["@octokit/openapi-types"] = "^27.0.0";
});
check(
  "fails when an upstream type anchor drifts from the twin's own spec",
  !driftedAnchor.ok && /@octokit\/openapi-types/.test(driftedAnchor.output),
  driftedAnchor.output,
);

const droppedSubpath = withMutatedManifest((m) => {
  delete m.exports["./server"];
});
check(
  "fails when an export-spec subpath disappears from the manifest",
  !droppedSubpath.ok && /\.\/server/.test(droppedSubpath.output),
  droppedSubpath.output,
);

const droppedTwin = withMutatedManifest((m) => {
  delete m.exports["./stripe"];
});
check(
  "fails when a per-twin subpath disappears",
  !droppedTwin.ok && /\.\/stripe/.test(droppedTwin.output),
  droppedTwin.output,
);

console.log("\ncheck-sandbox-domains-tarball.mjs — specifier scanning");

const JS_STATIC = /^\s*(?:import|export)\b[^;\n]*?\bfrom\s*(['"])([^'"]+)\1/gm;
const LOOSE = /(?:\bfrom\s*|\bimport\s*)\(?\s*(['"])([^'"]+)\1/g;

const PROSE_SAMPLES = [
  'const sql = `SELECT m.to_json AS "from", m.ts FROM messages m`;',
  'if (field === "from") return contains(document.from);',
  'const warning = "sent to everyone, some of them twice";',
];
for (const sample of PROSE_SAMPLES) {
  const loose = [...sample.matchAll(LOOSE)].map((m) => m[2]);
  const strict = [...sample.matchAll(JS_STATIC)].map((m) => m[2]);
  check(
    `prose is not read as an import: ${JSON.stringify(sample.slice(0, 44))}…`,
    strict.length === 0,
    `strict found ${JSON.stringify(strict)} (loose would have found ${JSON.stringify(loose)})`,
  );
}

const REAL_IMPORTS = [
  ['import { Hono } from "hono";', "hono"],
  ['import { sign } from "hono/jwt";', "hono/jwt"],
  ['export { z } from "zod";', "zod"],
  ['import { DatabaseSync } from "node:sqlite";', "node:sqlite"],
];
for (const [line, expected] of REAL_IMPORTS) {
  const found = [...line.matchAll(JS_STATIC)].map((m) => m[2]);
  check(`still finds a real import: ${expected}`, found.includes(expected), JSON.stringify(found));
}

const packageNameOf = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};
check("hono/jwt resolves to the hono package", packageNameOf("hono/jwt") === "hono");
check(
  "a scoped subpath keeps both segments",
  packageNameOf("@octokit/openapi-types") === "@octokit/openapi-types",
);
check("a scoped deep subpath keeps two segments", packageNameOf("@scope/pkg/deep") === "@scope/pkg");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll check-sandbox-domains-tarball.mjs checks passed.");
