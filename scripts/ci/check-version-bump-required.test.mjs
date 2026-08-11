#!/usr/bin/env node
/**
 * Regression coverage for scripts/ci/check-version-bump-required.mjs.
 *
 * Stands up a throwaway git repo with the manifests the gate knows about, then
 * drives it over real commits so the `git diff --name-only base HEAD` path is
 * exercised rather than mocked.
 *
 * The case that motivated this file (F-1375): `cli/` is a publish-relevant
 * PREFIX, so a PR touching only `cli/test/**` used to be told to bump
 * `@pome-sh/cli` — publishing a tarball whose bytes are identical, because no
 * package's `files` array names a test directory. RELEASING.md already said
 * that shouldn't happen; the prefix match didn't know it. A test path is now
 * dropped before the match, EXCEPT under `examples/`, `assets/` and `tasks/`,
 * which the CLI's `files` array really does publish verbatim.
 *
 * F-1455 (reproduced by PR #366 / F-1453) found the same shape of bug one
 * prefix over: `packages/twin-` is also a plain string prefix, so it matched
 * a twin's own top-level `examples/` even though those files ship in no
 * tarball — not because of `files` (twin-github and twin-slack's `files`
 * DOES name `dist`, and their examples compile into `dist/examples/`), but
 * because every twin-* package is `private: true` and release.yml publishes
 * only cli, adapter-claude-sdk, checks and wire. The `examples/` carve-back
 * above does not apply here — that one exists because `cli/examples` really
 * does ship — so this needed a second, separately anchored exemption, one
 * scoped to a single path segment so a twin's `src/examples/` (which DOES
 * compile into that twin's `dist`) stays caught.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/check-version-bump-required.mjs");

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

/**
 * Build a repo whose base commit carries the given manifest versions, apply
 * `changes` as a second commit, and run the gate against the base sha.
 */
function run({ changes, versions = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "version-bump-gate-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "ci@example.com");
    git(dir, "config", "user.name", "ci");
    write(dir, "cli/package.json", JSON.stringify({ name: "@pome-sh/cli", version: "1.0.0" }));
    write(
      dir,
      "packages/adapter-claude-sdk/package.json",
      JSON.stringify({ name: "@pome-sh/adapter-claude-sdk", version: "1.0.0" }),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const baseSha = git(dir, "rev-parse", "HEAD");

    for (const [relPath, contents] of Object.entries(changes)) write(dir, relPath, contents);
    for (const [manifest, version] of Object.entries(versions)) {
      const name = manifest.startsWith("cli") ? "@pome-sh/cli" : "@pome-sh/adapter-claude-sdk";
      write(dir, manifest, JSON.stringify({ name, version }));
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "change");

    const r = spawnSync("node", [SCRIPT, baseSha], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("check-version-bump-required.mjs");

{
  const r = run({ changes: { "cli/test/unit/thing.test.ts": "// test only\n" } });
  check("test-only change under cli/test/ needs no bump", r.status === 0, r.out);
}

{
  const r = run({ changes: { "packages/adapter-claude-sdk/test/spans.test.ts": "// test\n" } });
  check("test-only change in the adapter needs no bump", r.status === 0, r.out);
}

{
  const r = run({ changes: { "cli/src/thing.ts": "export const a = 1;\n" } });
  check(
    "src change with no bump still fails",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n" },
    versions: { "cli/package.json": "1.0.1" },
  });
  check("src change WITH a bump passes", r.status === 0, r.out);
}

{
  // A test file mixed in with a src change must not mask the src change.
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n", "cli/test/thing.test.ts": "// t\n" },
  });
  check("src + test change with no bump still fails", r.status === 1, r.out);
}

{
  // `files: ["examples", ...]` publishes these verbatim, so they are not
  // exempt just because of the filename.
  const r = run({ changes: { "cli/examples/demo/smoke.test.ts": "// shipped\n" } });
  check("a *.test.ts under cli/examples/ still demands a bump", r.status === 1, r.out);
}

{
  const r = run({ changes: { "cli/tasks/thing/test/fixture.json": "{}\n" } });
  check("a test/ dir under cli/tasks/ still demands a bump", r.status === 1, r.out);
}

{
  // The downgrade guard is independent of the test filter.
  const r = run({
    changes: { "cli/src/thing.ts": "export const a = 1;\n" },
    versions: { "cli/package.json": "0.9.0" },
  });
  check("a BEHIND version still fails", r.status === 1 && r.out.includes("BEHIND"), r.out);
}

{
  // F-1455 (PR #366 / F-1453): `packages/twin-` is a plain prefix, so it
  // over-matched a twin's own top-level examples/ — files that ship in no
  // tarball because every twin-* package is `private: true` and release.yml
  // publishes only cli, adapter-claude-sdk, checks and wire.
  const r = run({
    changes: { "packages/twin-stripe/examples/buyer-agent/package-lock.json": "{}\n" },
  });
  check("a change confined to a twin's examples/ needs no bump", r.status === 0, r.out);
}

{
  // Same over-match as F-1455, one directory over: a twin's own top-level
  // markdown ships in no tarball (every twin-* is `private: true`), and tsup
  // cannot inline a markdown file into the CLI's bundle either way. Demanding a
  // bump here demands a byte-identical republish, and RELEASING.md's "don't
  // touch a publish-relevant path" has no answer — a twin's FIDELITY.md has
  // nowhere else to live.
  const r = run({
    changes: { "packages/twin-github/FIDELITY.md": "## Known divergences\n\n1. **A.** b\n" },
  });
  check("a change confined to a twin's top-level docs needs no bump", r.status === 0, r.out);
}

{
  // Anchoring check, single path segment: `[^/]+\/[^/]+\.md` must not loosen.
  // Nothing under a twin's src/ is exempt, markdown or otherwise — the point of
  // the exemption is "documentation at the package root", not "any .md".
  const r = run({
    changes: {
      "packages/twin-github/FIDELITY.md": "# doc\n",
      "packages/twin-github/src/index.ts": "export const a = 1;\n",
    },
  });
  check(
    "a doc change RIDING ALONG with a src change still demands a bump",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  // Anchoring check: a twin's src/ is very much publish-relevant (it's what
  // tsup inlines into the CLI's tarball), so the new exemption must not have
  // widened to cover it.
  const r = run({
    changes: { "packages/twin-stripe/src/index.ts": "export const a = 1;\n" },
  });
  check(
    "a twin's src/ change with no bump still fails",
    r.status === 1 && r.out.includes("@pome-sh/cli"),
    r.out,
  );
}

{
  // Anchoring check, single path segment: `[^/]+` must not loosen to `.+`.
  // packages/twin-stripe/src/examples/handler.ts compiles into that twin's
  // own dist/ same as any other src/ module — a real publish-relevant file
  // that a looser regex would wrongly exempt.
  const r = run({
    changes: { "packages/twin-stripe/src/examples/handler.ts": "export const a = 1;\n" },
  });
  check("a twin's src/examples/ change with no bump still fails", r.status === 1, r.out);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
