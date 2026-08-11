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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
