#!/usr/bin/env node
/**
 * Regression coverage for scripts/check-cli-version-bump.sh (F-1135).
 *
 * The gate's header always claimed it covered "twin swaps" — a shipping change
 * that touches no file under cli/src/** — via `cli/vendor/**`. That directory no
 * longer exists, so the claim had gone quietly false: bumping a bundled
 * `@pome-sh/*` pin changed what users install and required neither a changeset
 * nor a version bump. F-1132 is what that silence costs, and the coverage below
 * is the restored half.
 *
 * Runs against throwaway git repos with `npm` mocked on PATH (the script probes
 * the registry for its first-publish E404 escape hatch).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-cli-version-bump.sh");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const BASE_MANIFEST = {
  name: "@pome-sh/cli",
  version: "0.12.0",
  dependencies: { "@pome-sh/twin-github": "0.5.0", commander: "^15.0.0" },
  bundleDependencies: ["@pome-sh/twin-github"],
};

/**
 * Build a repo whose base commit holds BASE_MANIFEST, then apply `mutate` and
 * commit that as HEAD.
 * @param mutate  (dir) => void — edits made in the HEAD commit.
 */
function repoWithChange(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "bump-gate-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "cli/.changeset"), { recursive: true });
  mkdirSync(join(dir, "cli/src"), { recursive: true });
  writeFileSync(join(dir, "cli/.changeset/README.md"), "# changesets\n");
  writeFileSync(join(dir, "cli/src/main.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "cli/package.json"), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "branch", "base");
  mutate(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head");
  return dir;
}

/** Mock `npm view` as succeeding, so the E404 first-publish bypass stays shut. */
function fakeNpmDir() {
  const bin = mkdtempSync(join(tmpdir(), "fake-npm-bump-"));
  writeFileSync(join(bin, "npm"), '#!/usr/bin/env bash\necho "0.12.0"\n');
  spawnSync("chmod", ["755", join(bin, "npm")]);
  return bin;
}

function run(dir) {
  const bin = fakeNpmDir();
  const r = spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, BASE_REF: "base", PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  rmSync(bin, { recursive: true, force: true });
  return r;
}

function writeManifest(dir, mutateManifest) {
  const manifest = JSON.parse(JSON.stringify(BASE_MANIFEST));
  mutateManifest(manifest);
  writeFileSync(join(dir, "cli/package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function main() {
  // 1 — a bundled @pome-sh pin moves with no changeset and no version bump. This
  // is the F-1132 shape and it must fail: the pin is baked into the published
  // tarball, so it changed what users install.
  {
    const dir = repoWithChange((d) =>
      writeManifest(d, (m) => {
        m.dependencies["@pome-sh/twin-github"] = "0.6.0";
      }),
    );
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 1, `pin bump without changeset must fail, got ${r.status}: ${r.stdout}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("@pome-sh/twin-github"), `must name the pin that moved: ${out}`);
  }

  // 2 — same pin bump, with a changeset. Passes.
  {
    const dir = repoWithChange((d) => {
      writeManifest(d, (m) => {
        m.dependencies["@pome-sh/twin-github"] = "0.6.0";
      });
      writeFileSync(join(d, "cli/.changeset/brave-twins.md"), '---\n"@pome-sh/cli": patch\n---\n\nre-pin\n');
    });
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 0, `pin bump + changeset must pass: ${r.stdout}${r.stderr}`);
  }

  // 3 — same pin bump, with a direct version bump instead. Passes.
  {
    const dir = repoWithChange((d) =>
      writeManifest(d, (m) => {
        m.dependencies["@pome-sh/twin-github"] = "0.6.0";
        m.version = "0.12.1";
      }),
    );
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 0, `pin bump + version bump must pass: ${r.stdout}${r.stderr}`);
  }

  // 4 — a third-party dep bump is not a bundled-twin swap. npm resolves those at
  // install time, so it must not trip this gate (staying narrow keeps the gate
  // credible).
  {
    const dir = repoWithChange((d) =>
      writeManifest(d, (m) => {
        m.dependencies.commander = "^16.0.0";
      }),
    );
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 0, `third-party dep bump must not trip the gate: ${r.stdout}${r.stderr}`);
  }

  // 5 — the pre-existing behaviour still holds: cli/src/** without a changeset
  // fails, and with one passes.
  {
    const dir = repoWithChange((d) =>
      writeFileSync(join(d, "cli/src/main.ts"), "export const x = 2;\n"),
    );
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 1, `cli/src change without changeset must still fail, got ${r.status}`);
  }
  {
    const dir = repoWithChange((d) => {
      writeFileSync(join(d, "cli/src/main.ts"), "export const x = 2;\n");
      writeFileSync(join(d, "cli/.changeset/tidy-fix.md"), '---\n"@pome-sh/cli": patch\n---\n\nfix\n');
    });
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 0, `cli/src change with changeset must pass: ${r.stdout}${r.stderr}`);
  }

  // 6 — a PR that touches neither cli/src nor the pins skips cleanly.
  {
    const dir = repoWithChange((d) => writeFileSync(join(d, "README.md"), "docs\n"));
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    assert(r.status === 0, `unrelated change must skip: ${r.stdout}${r.stderr}`);
    assert(/skipped/.test(r.stdout), `expected a skip message: ${r.stdout}`);
  }

  console.log("✅ CLI version-bump gate regression tests passed");
}

main();
