#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Both directions per rule, plus the two CHANGELOG properties: a rewritten released
// entry reds, and a heading that disagrees with its manifest version reds.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPublishIrrelevantPath, PUBLISHED_PACKAGES } from "./publish-relevance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/check-release-note-required.mjs");
const BASE_VERSION = "1.0.0";

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, relPath, contents) {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
}

const baseChangelog = (name, version = BASE_VERSION) =>
  `# ${name} — CHANGELOG\n\n## ${version} — 2026-08-01\n\nThe entry that already shipped.\n`;

function addPendingEntry(text, { level = "patch", body = "- a thing a consumer must know" } = {}) {
  const at = text.indexOf("## ");
  return `${text.slice(0, at)}## Unreleased (${level})\n\n${body}\n\n${text.slice(at)}`;
}

function run({ changes = {}, versions = {}, entries = [], changelogs = {}, seedChangelogVersion = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "release-note-gate-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "ci@example.com");
    git(dir, "config", "user.name", "ci");
    for (const pkg of PUBLISHED_PACKAGES) {
      write(dir, pkg.manifest, `{\n  "name": "${pkg.name}",\n  "version": "${BASE_VERSION}"\n}\n`);
      write(dir, pkg.changelog, baseChangelog(pkg.name, seedChangelogVersion[pkg.name] ?? BASE_VERSION));
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const baseSha = git(dir, "rev-parse", "HEAD");

    for (const [relPath, contents] of Object.entries(changes)) write(dir, relPath, contents);
    for (const pkg of PUBLISHED_PACKAGES) {
      if (versions[pkg.name]) {
        write(dir, pkg.manifest, `{\n  "name": "${pkg.name}",\n  "version": "${versions[pkg.name]}"\n}\n`);
      }
      if (entries.includes(pkg.name)) {
        write(dir, pkg.changelog, addPendingEntry(readFileSync(join(dir, pkg.changelog), "utf8")));
      }
      if (changelogs[pkg.name]) write(dir, pkg.changelog, changelogs[pkg.name]);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", "change");

    const r = spawnSync("node", [SCRIPT, baseSha], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("check-release-note-required.mjs — publish relevance (inherited)");

{
  const r = run({ changes: { "cli/test/unit/thing.test.ts": "// test only\n" } });
  check("test-only change under cli/test/ needs no entry", r.status === 0, r.out);
}

{
  const r = run({ changes: { "packages/checks/test/spans.test.ts": "// test\n" } });
  check("test-only change in a package needs no entry", r.status === 0, r.out);
}

{
  const r = run({ changes: { "cli/src/thing.ts": "export const a = 1;\n" } });
  check(
    "src change with no entry fails, naming the package and the shape to add",
    r.status === 1 && r.out.includes("@pome-sh/cli") && r.out.includes("## Unreleased (patch)"),
    r.out,
  );
}

{
  const r = run({ changes: { "cli/src/thing.ts": "export const a = 1;\n" }, entries: ["@pome-sh/cli"] });
  check("src change WITH an entry passes", r.status === 0, r.out);
}

{
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n", "cli/test/thing.test.ts": "// t\n" },
  });
  check("src + test change with no entry still fails", r.status === 1, r.out);
}

{
  const r = run({ changes: { "cli/examples/demo/smoke.test.ts": "// shipped\n" } });
  check("a *.test.ts under cli/examples/ still demands an entry", r.status === 1, r.out);
}

{
  const r = run({ changes: { "cli/tasks/thing/test/fixture.json": "{}\n" } });
  check("a test/ dir under cli/tasks/ still demands an entry", r.status === 1, r.out);
}

{
  const r = run({
    changes: { "packages/twin-stripe/examples/buyer-agent/package-lock.json": "{}\n" },
  });
  check("a change confined to a twin's examples/ needs no entry", r.status === 0, r.out);
}

{
  const r = run({
    changes: { "packages/twin-github/FIDELITY.md": "## Known divergences\n\n1. **A.** b\n" },
  });
  check("a change confined to a twin's top-level docs needs no entry", r.status === 0, r.out);
}

{
  const r = run({
    changes: {
      "packages/twin-github/FIDELITY.md": "# doc\n",
      "packages/twin-github/src/index.ts": "export const a = 1;\n",
    },
  });
  check(
    "a doc change RIDING ALONG with a src change still demands an entry",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({ changes: { "packages/twin-stripe/src/index.ts": "export const a = 1;\n" } });
  check(
    "a twin's src/ change with no entry still fails",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({ changes: { "packages/twin-stripe/src/examples/handler.ts": "export const a = 1;\n" } });
  check("a twin's src/examples/ change with no entry still fails", r.status === 1, r.out);
}

{
  const r = run({ changes: { "packages/twin-github/scripts/validate-mcp.ts": "// tooling\n" } });
  check("a change confined to a twin's scripts/ needs no entry", r.status === 0, r.out);
}

{
  const r = run({ changes: { "packages/twin-stripe/src/scripts/gen.ts": "export const a = 1;\n" } });
  check(
    "a twin's src/scripts/ change with no entry still fails",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({ changes: { "cli/scripts/copy-prompts.mjs": "// tooling\n" } });
  check(
    "a cli/scripts/ change with no entry still fails",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({
    changes: {
      "packages/twin-github/scripts/validate-mcp.ts": "// tooling\n",
      "packages/twin-github/src/index.ts": "export const a = 1;\n",
    },
  });
  check(
    "a script change RIDING ALONG with a src change still demands an entry",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({
    changes: {
      "packages/twin-github/Dockerfile": "FROM node:24-trixie-slim\n",
      "packages/twin-gmail/Dockerfile": "FROM node:26-trixie-slim\n",
      "packages/twin-linear/Dockerfile": "FROM node:26-trixie-slim\n",
      "packages/twin-slack/Dockerfile": "FROM node:24-trixie-slim\n",
      "packages/twin-stripe/Dockerfile": "FROM node:24-trixie-slim\n",
    },
  });
  check("a change confined to the twins' Dockerfiles needs no entry", r.status === 0, r.out);
}

{
  const r = run({ changes: { "packages/twin-stripe/src/Dockerfile": "FROM scratch\n" } });
  check(
    "a Dockerfile under a twin's src/ with no entry still fails",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({
    changes: {
      "packages/twin-stripe/Dockerfile": "FROM node:24-trixie-slim\n",
      "packages/twin-stripe/src/index.ts": "export const a = 1;\n",
    },
  });
  check(
    "a Dockerfile change RIDING ALONG with a src change still demands an entry",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

console.log("the coupling: one change, several artifacts");

{
  const r = run({ changes: { "packages/wire/src/thing.ts": "export const a = 1;\n" } });
  const named = PUBLISHED_PACKAGES.filter((pkg) => r.out.includes(`${pkg.name}: this PR changes`)).map(
    (pkg) => pkg.name,
  );
  check(
    "a wire src change demands an entry from wire and the CLI",
    r.status === 1 &&
      named.length === 2 &&
      ["@pome-sh/wire", "@pome-sh/cli"].every((name) => named.includes(name)),
    `named: ${named.join(", ") || "none"}\n${r.out}`,
  );
  const all = run({
    changes: { "packages/wire/src/thing.ts": "export const a = 1;\n" },
    entries: named,
  });
  check("…and passes once both carry one", all.status === 0, all.out);
}

{
  const plain = run({ changes: { "packages/sdk/src/registry.ts": "export const a = 1;\n" } });
  check(
    "a non-declaration sdk change demands the CLI only",
    plain.status === 1 &&
      plain.out.includes("@pome-sh/cli: this PR changes") &&
      !plain.out.includes("@pome-sh/checks: this PR changes"),
    plain.out,
  );
  const declaration = run({ changes: { "packages/sdk/src/checks.ts": "export const a = 1;\n" } });
  check(
    "a declaration-layer change demands the CLI AND the grading vocabulary",
    declaration.status === 1 &&
      declaration.out.includes("@pome-sh/cli: this PR changes") &&
      declaration.out.includes("@pome-sh/checks: this PR changes"),
    declaration.out,
  );
}

console.log("the number is not the PR's to write");

{
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n" },
    entries: ["@pome-sh/cli"],
    versions: { "@pome-sh/cli": "1.0.1" },
  });
  check(
    "a hand-written version bump fails even with a perfect entry",
    r.status === 1 && r.out.includes("allocated on `main`"),
    r.out,
  );
}

{
  const r = run({ versions: { "@pome-sh/cli": "0.9.0" }, entries: ["@pome-sh/cli"] });
  check("a version moved DOWN is refused too", r.status === 1 && r.out.includes("0.9.0"), r.out);
}

console.log("the CHANGELOG contract");

{
  const r = run({ entries: ["@pome-sh/checks"] });
  check("a pending entry with no code change is allowed", r.status === 0, r.out);
}

{
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n" },
    changelogs: {
      "@pome-sh/cli": `# @pome-sh/cli — CHANGELOG\n\n## Unreleased (patch)\n\n\n## ${BASE_VERSION} — 2026-08-01\n\nThe entry that already shipped.\n`,
    },
  });
  check(
    "an empty pending body is not an entry",
    r.status === 1 && r.out.includes("no pending entry"),
    r.out,
  );
}

{
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n" },
    changelogs: {
      "@pome-sh/cli": `# @pome-sh/cli — CHANGELOG\n\n## Unreleased\n\n- words\n\n## ${BASE_VERSION} — 2026-08-01\n\nThe entry that already shipped.\n`,
    },
  });
  check(
    "`## Unreleased` with no level is REFUSED, not read as absent",
    r.status === 1 && r.out.includes("not a release request"),
    r.out,
  );
}

{
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n" },
    changelogs: {
      "@pome-sh/cli": addPendingEntry(
        `# @pome-sh/cli — CHANGELOG\n\n## ${BASE_VERSION} — 2026-08-01\n\nThe entry that already shipped, EDITED.\n`,
      ),
    },
  });
  check(
    "rewriting a released entry fails, entry or no entry",
    r.status === 1 && r.out.includes("byte-identical"),
    r.out,
  );
}

{
  const r = run({
    changelogs: {
      "@pome-sh/cli": `# @pome-sh/cli — CHANGELOG\n\nA new note about how this file works.\n\n## ${BASE_VERSION} — 2026-08-01\n\nThe entry that already shipped.\n`,
    },
  });
  check("editing the preamble above the first heading is allowed", r.status === 0, r.out);
  check(
    "…and the CHANGELOG itself is counted as exempt from publish relevance",
    /1 file\(s\) changed, 1 exempt/.test(r.out),
    r.out,
  );
}

{
  const r = run({ seedChangelogVersion: { "@pome-sh/cli": "0.9.0" } });
  check(
    "a released heading that disagrees with the manifest version fails",
    r.status === 1 && r.out.includes("newest") && r.out.includes("0.9.0"),
    r.out,
  );
}

console.log("the gate's own surface");

{
  const r = run({ changes: { "README.md": "# hi\n" } });
  check("a docs-only PR passes", r.status === 0, r.out);
  check(
    "…and says how many packages it judged, so a green cannot mean an empty subject",
    r.out.includes(`${PUBLISHED_PACKAGES.length} published package(s)`),
    r.out,
  );
}

{
  const r = run({
    changelogs: { "@pome-sh/cli": `${baseChangelog("@pome-sh/cli")}\nA trailing note.\n` },
  });
  check(
    "appending below the newest released entry is a rewrite, and refused",
    r.status === 1 && r.out.includes("byte-identical"),
    r.out,
  );
}

{
  const exemptedPublished = PUBLISHED_PACKAGES.flatMap((pkg) => {
    const directory = dirname(pkg.manifest);
    return [`${directory}/README.md`, `${directory}/examples/demo/index.ts`, `${directory}/scripts/validate.ts`]
      .filter((path) => isPublishIrrelevantPath(path) !== null)
      .map((path) => `${pkg.name}: ${path} — ${isPublishIrrelevantPath(path)}`);
  });
  check(
    "no carve-out exempts a path inside a package that publishes",
    exemptedPublished.length === 0,
    exemptedPublished.join("\n      "),
  );

  check(
    "the private twins keep their carve-outs",
    isPublishIrrelevantPath("packages/twin-github/FIDELITY.md") !== null &&
      isPublishIrrelevantPath("packages/twin-stripe/examples/buyer-agent/index.ts") !== null &&
      isPublishIrrelevantPath("packages/twin-github/scripts/validate-mcp.ts") !== null,
  );

  const bundlerConsumers = PUBLISHED_PACKAGES.filter((pkg) =>
    (pkg.pathPatterns ?? []).some((pattern) => pattern.test("scripts/bundle-declarations.mjs")),
  ).map((pkg) => pkg.name);
  check(
    "the shared declaration bundler is publish-relevant for both bundling packages",
    bundlerConsumers.includes("@pome-sh/checks") &&
      bundlerConsumers.includes("@pome-sh/sandbox-domains"),
    `named by: ${bundlerConsumers.join(", ") || "(nobody)"}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
