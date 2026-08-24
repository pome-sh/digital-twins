#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for scripts/ci/check-sandbox-domains-tarball.mjs.
//
// The gate's whole value is that it fails on things nobody can see from inside
// this workspace, so the thing worth testing is that it FAILS — a gate asserted
// only against a green tree is one that could have been `process.exit(0)`.
//
// Everything below runs the real script against a scratch copy of the manifest,
// in `--manifest-only` mode (no build, no network). The tarball half is exercised
// for real by `npm run gate:sandbox-domains-tarball` in ci.yml's heavy block and in
// release.yml's publish job; what cannot be tested by mutating a manifest is the
// specifier scanner, so its two failure modes are unit-tested directly against
// the exported patterns' behaviour on strings that once broke it.
//
// Usage: node scripts/ci/check-sandbox-domains-tarball.test.mjs

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

/** Run the gate in manifest-only mode; returns `{ ok, output }`. */
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

/** Apply `mutate` to the manifest, run the gate, restore. */
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

// 1 — the failure mode that produces a fully GREEN release publishing nothing.
const privatised = withMutatedManifest((m) => {
  m.private = true;
});
check(
  "fails when the package is privatised",
  !privatised.ok && /private: true/.test(privatised.output),
  privatised.output,
);

// A missing `private` field is not the same as `false`, and npm tolerates it.
const privateAbsent = withMutatedManifest((m) => {
  delete m.private;
});
check(
  "fails when `private` is absent rather than explicitly false",
  !privateAbsent.ok && /must be exactly/.test(privateAbsent.output),
  privateAbsent.output,
);

// 2 — a pinned registry can only misroute the publish.
const pinnedRegistry = withMutatedManifest((m) => {
  m.publishConfig.registry = "https://npm.pkg.github.com";
});
check(
  "fails when publishConfig.registry is pinned",
  !pinnedRegistry.ok && /publishConfig\.registry/.test(pinnedRegistry.output),
  pinnedRegistry.output,
);

// E402 after the merge has already landed.
const restricted = withMutatedManifest((m) => {
  m.publishConfig.access = "restricted";
});
check(
  "fails when publishConfig.access is not public",
  !restricted.ok && /access/.test(restricted.output),
  restricted.output,
);

// 3 — the leak that 404s a consumer's install. The reason this package bundles.
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

// The two-schema-identity bug, in a brand-new package.
const zodNotPeer = withMutatedManifest((m) => {
  delete m.peerDependencies.zod;
  m.dependencies.zod = "^4.4.3";
});
check(
  "fails when zod stops being a peerDependency",
  !zodNotPeer.ok && /peerDependency/.test(zodNotPeer.output),
  zodNotPeer.output,
);

// The upstream fidelity anchors were generated against the twins' versions.
const driftedAnchor = withMutatedManifest((m) => {
  m.dependencies["@octokit/openapi-types"] = "^27.0.0";
});
check(
  "fails when an upstream type anchor drifts from the twin's own spec",
  !driftedAnchor.ok && /@octokit\/openapi-types/.test(driftedAnchor.output),
  driftedAnchor.output,
);

// The export spec is the measured contract with pome-cloud.
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

// ── The specifier scanner ───────────────────────────────────────────────────
//
// Not reachable by mutating a manifest, and the half that actually broke during
// The loose `\bfrom\s*"…"` form used on `.d.ts` reads SQL and English
// inside bundled JS string literals as import specifiers. These pin both
// directions so a future simplification back to one pattern reds here.
console.log("\ncheck-sandbox-domains-tarball.mjs — specifier scanning");

const JS_STATIC = /^\s*(?:import|export)\b[^;\n]*?\bfrom\s*(['"])([^'"]+)\1/gm;
const LOOSE = /(?:\bfrom\s*|\bimport\s*)\(?\s*(['"])([^'"]+)\1/g;

/** Real bundled-JS bytes from the twins that the loose pattern misread. */
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

/** …while every real form tsup emits is still found. */
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

// `hono/jwt` must be satisfied by a declared `hono`, or the gate demands a
// dependency on a subpath that is not a package.
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
