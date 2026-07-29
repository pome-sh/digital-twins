#!/usr/bin/env node
/**
 * Regression coverage for scripts/check-cli-pins-published.mjs (F-1135).
 *
 * Mocks `npm` on PATH — no registry calls. The case that matters is the three
 * way split: a pin that is missing from npm because its batch has not published
 * yet is a legitimate SKIP, a pin that is missing AND disagrees with the
 * workspace is a bogus pin and must FAIL, and a registry failure that is not
 * E404 must fail closed rather than be read as "not published".
 *
 * The step this replaces checked seven hard-coded version literals that were
 * true for exactly one day; the last case asserts the literals are really gone
 * from cli-release.yml, since a gate that still reads its own copy of the
 * versions is the bug, not the fix.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-cli-pins-published.mjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fixtureRoot(pins, workspaceVersions) {
  const dir = mkdtempSync(join(tmpdir(), "pins-pub-"));
  mkdirSync(join(dir, "cli"), { recursive: true });
  writeFileSync(
    join(dir, "cli/package.json"),
    JSON.stringify({ name: "@pome-sh/cli", version: "0.12.0", dependencies: pins }, null, 2),
  );
  for (const [name, version] of Object.entries(workspaceVersions)) {
    mkdirSync(join(dir, "packages", name), { recursive: true });
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({ name: `@pome-sh/${name}`, version }, null, 2),
    );
  }
  return dir;
}

/**
 * @param published  `["@pome-sh/sdk@0.8.0", ...]` — specs the fake registry has.
 * @param mode       "e404" (default) or "network" — how misses are reported.
 */
function run(root, published, mode = "e404") {
  const bin = mkdtempSync(join(tmpdir(), "fake-npm-"));
  writeFileSync(join(bin, "published.json"), JSON.stringify(published));
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
# args: view <spec> version
spec="$2"
node -e '
const fs = require("fs");
const have = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const spec = process.argv[2];
if (have.includes(spec)) { console.log(spec.split("@").pop()); process.exit(0); }
if (process.argv[3] === "network") {
  console.error("npm error code EAI_AGAIN\\nnpm error network request failed");
  process.exit(1);
}
console.error("npm error code E404\\nnpm error 404 Not Found - GET " + spec);
process.exit(1);
' "$(dirname "$0")/published.json" "$spec" "\${MOCK_MODE:-e404}"
`,
  );
  spawnSync("chmod", ["755", join(bin, "npm")]);
  const outFile = join(bin, "gh-output");
  writeFileSync(outFile, "");
  const result = spawnSync("node", [SCRIPT, root], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MOCK_MODE: mode,
      GITHUB_OUTPUT: outFile,
    },
  });
  result.ghOutput = readFileSync(outFile, "utf8");
  rmSync(bin, { recursive: true, force: true });
  return result;
}

function main() {
  // 1 — every pin resolves: ready=true, and the versions came from the manifest.
  {
    const root = fixtureRoot(
      { "@pome-sh/sdk": "0.8.0", "@pome-sh/twin-github": "0.5.0" },
      { sdk: "0.8.0", "twin-github": "0.5.0" },
    );
    const r = run(root, ["@pome-sh/sdk@0.8.0", "@pome-sh/twin-github@0.5.0"]);
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert(/ready=true/.test(r.ghOutput), `expected ready=true, got ${r.ghOutput}`);
  }

  // 2 — pin matches the workspace but is not on npm yet: the packages-v* batch
  // has not published. That is the designed SKIP, not a failure — hard-failing
  // here would block every release whose batch lags.
  {
    const root = fixtureRoot({ "@pome-sh/sdk": "0.9.0" }, { sdk: "0.9.0" });
    const r = run(root, []);
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 0, `unpublished-but-current must not fail: ${r.stderr}`);
    assert(/ready=false/.test(r.ghOutput), `expected ready=false, got ${r.ghOutput}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("@pome-sh/sdk@0.9.0"), `must name what is unpublished: ${out}`);
  }

  // 3 — pin is not on npm AND disagrees with the workspace: nothing will ever
  // publish it, so waiting is the wrong answer. Fail and name it (Done-when 2).
  {
    const root = fixtureRoot({ "@pome-sh/sdk": "0.7.0" }, { sdk: "0.8.0" });
    const r = run(root, ["@pome-sh/sdk@0.8.0"]);
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 1, `bogus pin must fail, got ${r.status}: ${r.stdout}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("@pome-sh/sdk@0.7.0"), `must name the bogus pin: ${out}`);
    assert(out.includes("0.8.0"), `must name the workspace version: ${out}`);
  }

  // 4 — a non-E404 registry failure must fail closed. Reading a network blip as
  // "not published" would skip the release silently.
  {
    const root = fixtureRoot({ "@pome-sh/sdk": "0.8.0" }, { sdk: "0.8.0" });
    const r = run(root, [], "network");
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 2, `network failure must fail closed with 2, got ${r.status}`);
  }

  // 5 — non-@pome-sh deps are npm's problem, not this gate's: `commander` and
  // friends must not be probed (the old step did not, and doing so would make
  // the release wait on unrelated registry state).
  {
    const root = fixtureRoot(
      { "@pome-sh/sdk": "0.8.0", commander: "^15.0.0" },
      { sdk: "0.8.0" },
    );
    const r = run(root, ["@pome-sh/sdk@0.8.0"]);
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 0, `third-party deps must be ignored: ${r.stderr}`);
    assert(!/commander/.test(`${r.stdout}${r.stderr}`), "must not probe third-party deps");
  }

  // 6 — the stale literals are gone and the workflow calls this script.
  {
    const y = readFileSync(join(ROOT, ".github/workflows/cli-release.yml"), "utf8");
    assert(/check-cli-pins-published\.mjs/.test(y), "cli-release.yml must call the manifest gate");
    for (const stale of [
      "shared-types@0.11.0",
      "sdk@0.5.0",
      "twin-github@0.2.1",
      "twin-slack@0.2.1",
      "twin-stripe@0.2.4",
      "twin-gmail@0.1.0",
    ]) {
      assert(!y.includes(stale), `stale hard-coded literal still present: ${stale}`);
    }
  }

  console.log("✅ CLI published-pins gate regression tests passed");
}

main();
