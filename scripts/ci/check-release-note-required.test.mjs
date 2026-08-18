#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for scripts/ci/check-release-note-required.mjs.
 *
 * Stands up a throwaway git repo carrying every manifest and CHANGELOG the gate
 * knows about, then drives it over real commits so the `git diff --name-only
 * base HEAD` / `git show base:path` paths are exercised rather than mocked.
 *
 * ── The cases inherited from the version-bump gate this file re-scopes ───────
 *
 * The publish-relevance table moved to `publish-relevance.mjs` (F-1511) but did
 * not change, and neither did the bugs it has been taught. Each carve-out below
 * is a measured over-match, and every one has the same shape: a plain string
 * prefix matching files that ship in no tarball, so a PR was told to publish a
 * byte-identical artifact.
 *
 *   F-1375  `cli/` matched `cli/test/**` — no package's `files` array names a
 *           test directory. Carved out EXCEPT under `examples/`, `assets/` and
 *           `tasks/`, which the CLI's `files` really does publish verbatim.
 *   F-1455  `packages/twin-` matched a twin's own top-level `examples/`
 *           (PR #366 / F-1453). Not because of `files` — twin-github's and
 *           twin-slack's `dist/examples/` really is packed — but because every
 *           twin is `private: true` and release.yml publishes only cli,
 *           adapter-claude-sdk, checks and wire. Same prefix, one directory
 *           over: a twin's top-level `.md`.
 *   F-1354  Same prefix again: a twin's own top-level `scripts/`, found on the
 *           PR whose whole job was wiring such a script into CI.
 *   F-1532  Same prefix, one file over: a twin's own `Dockerfile`. A GHCR image
 *           is not an npm artifact, so patching a base image was demanding both
 *           a cli and a sandbox-domains release. Found on the PR that had to
 *           edit all five to clear a fixable base-image CVE.
 *
 * Each carve-out is paired with an anchoring case (`src/examples/`,
 * `src/scripts/`, `cli/scripts/`, a doc riding along with a src change) because
 * a regex that widened to `.+` would pass every exemption test while quietly
 * stopping the demand for files that really do ship.
 *
 * ── The cases this file adds (F-1511) ───────────────────────────────────────
 *
 * The demand inverted: a PR must NOT write the number, and must carry the words.
 * Both directions are asserted, plus the two CHANGELOG properties that used to
 * be a convention with nothing behind them — released entries are never
 * rewritten, and the newest released heading names the version beside it.
 */
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

/** Insert a pending section above the released region, the way an author would. */
function addPendingEntry(text, { level = "patch", body = "- a thing a consumer must know" } = {}) {
  const at = text.indexOf("## ");
  return `${text.slice(0, at)}## Unreleased (${level})\n\n${body}\n\n${text.slice(at)}`;
}

/**
 * Build a repo whose base commit carries every published package at 1.0.0 with a
 * matching CHANGELOG, apply `changes` / `versions` / `entries` / `changelogs` as
 * a second commit, and run the gate against the base sha.
 *
 * `seedChangelogVersion` seeds a base that is ALREADY inconsistent, which is the
 * only way to reach the heading↔version check without also tripping the
 * hand-written-version one.
 */
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
    // `--allow-empty` so a case can seed an inconsistent BASE and change nothing
    // in the PR — which is how the heading↔version check is reached without also
    // tripping the hand-written-version one.
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
  const r = run({ changes: { "packages/adapter-claude-sdk/test/spans.test.ts": "// test\n" } });
  check("test-only change in the adapter needs no entry", r.status === 0, r.out);
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
  // A test file mixed in with a src change must not mask the src change.
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n", "cli/test/thing.test.ts": "// t\n" },
  });
  check("src + test change with no entry still fails", r.status === 1, r.out);
}

{
  // `files: ["examples", ...]` publishes these verbatim, so they are not exempt
  // just because of the filename.
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
  // Anchoring check, single path segment: `[^/]+\/[^/]+\.md` must not loosen.
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
  // Anchoring check: packages/twin-stripe/src/examples/handler.ts compiles into
  // that twin's own dist/ same as any other src/ module.
  const r = run({ changes: { "packages/twin-stripe/src/examples/handler.ts": "export const a = 1;\n" } });
  check("a twin's src/examples/ change with no entry still fails", r.status === 1, r.out);
}

{
  // F-1354: a twin's own top-level scripts/ is dev/CI tooling in no tarball.
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
  // Anchoring check: cli/scripts/ is NOT a twin script.
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
  // F-1532: a twin's Dockerfile builds its GHCR image, which no tarball carries.
  // The real case was all five at once, to clear a fixable base-image CVE.
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
  // Anchoring check, exact filename under the twin root: `src/` is where tsup
  // actually reaches, so a Dockerfile sitting there is not exempt.
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
  // wire's bytes are inlined into the CLI's and the adapter's tarballs, so one
  // wire change is THREE releases (RELEASING.md says so in as many words), and
  // the demand names all three: a PR that writes one entry and forgets two ships
  // two releases with no record of what is in them. `@pome-sh/checks` is
  // deliberately not among them — its relevance is named declaration FILES, not
  // whole directories.
  const r = run({ changes: { "packages/wire/src/thing.ts": "export const a = 1;\n" } });
  const named = PUBLISHED_PACKAGES.filter((pkg) => r.out.includes(`${pkg.name}: this PR changes`)).map(
    (pkg) => pkg.name,
  );
  check(
    "a wire src change demands an entry from wire, the CLI and the adapter",
    r.status === 1 &&
      named.length === 3 &&
      ["@pome-sh/wire", "@pome-sh/cli", "@pome-sh/adapter-claude-sdk"].every((name) =>
        named.includes(name),
      ),
    `named: ${named.join(", ") || "none"}\n${r.out}`,
  );
  const all = run({
    changes: { "packages/wire/src/thing.ts": "export const a = 1;\n" },
    entries: named,
  });
  check("…and passes once all three carry one", all.status === 0, all.out);
}

{
  // @pome-sh/checks' relevance is named FILES inside other packages, not whole
  // directories: a twin's or the sdk's non-declaration change is not a
  // vocabulary change.
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
  // The direction that used to have its own named failure: a version moved DOWN
  // (a stale branch rebased past a release) hard-failed release.yml's floor check
  // after merge. It is now the same failure as any other hand-written number,
  // which is the point — there is no longer a right value for a PR to carry.
  const r = run({ versions: { "@pome-sh/cli": "0.9.0" }, entries: ["@pome-sh/cli"] });
  check("a version moved DOWN is refused too", r.status === 1 && r.out.includes("0.9.0"), r.out);
}

console.log("the CHANGELOG contract");

{
  // A pending entry with no publish-relevant change is a deliberate release
  // request and must pass — the allocator honours it.
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
  // The preamble is explicitly NOT part of the record: it describes the format,
  // and this very ticket had to rewrite cli/CHANGELOG.md's. This is also the case
  // that proves a CHANGELOG is exempt from publish relevance — it is the one
  // changed file, and no release is demanded for it.
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
  // The surviving half of the old contract, on a base that is already
  // inconsistent — the shape a hand-edit on main would leave behind.
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
  // Appending BELOW the newest released heading is a rewrite of the record, not
  // an insertion — the same refusal as editing an entry in place, and the shape a
  // "just add a note at the bottom" edit takes.
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
  // Every carve-out in publish-relevance.mjs justifies itself with "the package
  // this path belongs to publishes nothing", so none of them may ever exempt a
  // path inside a package that DOES publish — that would drop a file which
  // really reaches a consumer's tarball out of the relevance table, silently.
  //
  // Written as a property over `PUBLISHED_PACKAGES` rather than against any one
  // package, because the way it breaks is a NAME. F-1526's package was called
  // `twin-domains` first, which put a published `README.md` (in its `files`) under
  // the `packages/twin-*` top-level-markdown carve-out; renaming it to
  // `sandbox-domains` is what actually fixed that, and the fix is invisible in
  // the carve-outs themselves. This is the assertion that notices if a future
  // package name — or a rename of the twins, which is coming — walks back into
  // one of these prefixes.
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

  // …and the carve-outs still apply to the five PRIVATE twins, or the rule was
  // widened into uselessness rather than kept honest.
  check(
    "the private twins keep their carve-outs",
    isPublishIrrelevantPath("packages/twin-github/FIDELITY.md") !== null &&
      isPublishIrrelevantPath("packages/twin-stripe/examples/buyer-agent/index.ts") !== null &&
      isPublishIrrelevantPath("packages/twin-github/scripts/validate-mcp.ts") !== null,
  );

  // The shared declaration bundler moved to scripts/ (F-1526) so sandbox-domains
  // could use it instead of copying ~300 lines. Both packages' `.d.ts` are
  // unresolvable for a consumer if it regresses, so it must stay publish-relevant
  // for both — the move must not have quietly dropped it out of the table.
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
