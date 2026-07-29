#!/usr/bin/env node
/**
 * Regression coverage for scripts/check-cli-pins-match-workspace.mjs (F-1135).
 *
 * The gate's whole job is to make the skew that shipped F-1132 impossible to
 * merge green, so the cases below are written from that incident: at `fbdac32`
 * `cli/package.json` pinned twin-github 0.4.0 while `packages/twin-github` held
 * 0.5.0, and cli-ci reported success. Case 2 IS that manifest.
 *
 * `evaluate()` is exercised directly (the cloud-first window table is an
 * in-script constant, so a fixture tree cannot declare one), and the CLI
 * entrypoint is exercised by spawning it against fixture roots and the real
 * repo. The last case asserts the gate is actually wired into ci.yml — a gate
 * nothing runs is the failure mode this ticket exists to prevent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate } from "./check-cli-pins-match-workspace.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-cli-pins-match-workspace.mjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Build a throwaway repo root: cli/package.json + packages/<name>/package.json. */
function fixtureRoot(pins, workspaceVersions) {
  const dir = mkdtempSync(join(tmpdir(), "pin-gate-"));
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

function run(root) {
  return spawnSync("node", [SCRIPT, root], { encoding: "utf8" });
}

function main() {
  // 1 — pins equal to the workspace: the only state in which the artifact CI
  // tests and the artifact users install agree.
  {
    const r = evaluate(
      { "@pome-sh/twin-github": "0.5.0", "@pome-sh/sdk": "0.8.0" },
      { "twin-github": "0.5.0", sdk: "0.8.0" },
      [],
    );
    assert(r.ok, `in-sync pins must pass: ${JSON.stringify(r)}`);
    assert(r.failures.length === 0, "in-sync pins must report no failures");
  }

  // 2 — the F-1132 manifest verbatim. Must fail, and must name BOTH versions
  // (the ticket's Done-when bullet 1 is explicit about that).
  {
    const r = evaluate(
      { "@pome-sh/twin-github": "0.4.0", "@pome-sh/sdk": "0.7.0" },
      { "twin-github": "0.5.0", sdk: "0.8.0" },
      [],
    );
    assert(!r.ok, "pin behind workspace must fail");
    assert(r.failures.length === 2, `expected both skews, got ${r.failures.length}`);
    const gh = r.failures.find((f) => f.name === "@pome-sh/twin-github");
    assert(gh, "twin-github skew must be reported");
    assert(gh.pin === "0.4.0" && gh.workspace === "0.5.0", `both versions: ${JSON.stringify(gh)}`);
  }

  // 3 — pin AHEAD of the workspace. Never a legitimate window: the repo cannot
  // pack the version the pin names, so the rewrite silently DOWNGRADES.
  {
    const r = evaluate({ "@pome-sh/twin-github": "0.6.0" }, { "twin-github": "0.5.0" }, []);
    assert(!r.ok, "pin ahead of workspace must fail");
    assert(r.failures[0].direction === "ahead", `direction: ${JSON.stringify(r.failures[0])}`);
  }

  // 4 — a declared cloud-first window (F-1075's ratified ordering) excuses a
  // pin that lags, and is reported rather than silent.
  {
    const windows = [
      { name: "@pome-sh/twin-github", pin: "0.4.0", workspace: "0.5.0", reason: "F-1075 window" },
    ];
    const r = evaluate({ "@pome-sh/twin-github": "0.4.0" }, { "twin-github": "0.5.0" }, windows);
    assert(r.ok, `declared window must pass: ${JSON.stringify(r)}`);
    assert(r.excused.length === 1, "the window must be reported, not silent");
    assert(r.excused[0].reason.includes("F-1075"), "the reason must survive to the report");
  }

  // 5 — ANTI-ROT, the property that keeps this gate from becoming
  // cli-release.yml's seven stale literals (Validation 4). A window is pinned
  // to the exact pair it was written for; when either side moves again the
  // window stops matching and the gate re-arms.
  {
    const windows = [
      { name: "@pome-sh/twin-github", pin: "0.4.0", workspace: "0.5.0", reason: "F-1075 window" },
    ];
    // workspace moved on to 0.6.0 — the recorded window is now stale.
    const moved = evaluate({ "@pome-sh/twin-github": "0.4.0" }, { "twin-github": "0.6.0" }, windows);
    assert(!moved.ok, "a window must not excuse a pair it was not written for (workspace moved)");
    // pin moved to 0.4.1 — likewise stale.
    const repinned = evaluate(
      { "@pome-sh/twin-github": "0.4.1" },
      { "twin-github": "0.5.0" },
      windows,
    );
    assert(!repinned.ok, "a window must not excuse a pair it was not written for (pin moved)");
  }

  // 6 — an @pome-sh dep with no packages/ directory (e.g. a package that does
  // not live in this workspace) is out of scope, not a failure.
  {
    const r = evaluate({ "@pome-sh/not-in-workspace": "9.9.9" }, { sdk: "0.8.0" }, []);
    assert(r.ok, `unknown @pome-sh dep must be ignored: ${JSON.stringify(r)}`);
    assert(r.checked.length === 0, "nothing to check when the dep has no workspace package");
  }

  // 7 — a range/tag pin cannot be compared to an exact workspace version, and
  // must not pass silently: bundleDependencies freezes whatever it resolved.
  {
    const r = evaluate({ "@pome-sh/sdk": "^0.8.0" }, { sdk: "0.8.0" }, []);
    assert(!r.ok, "a non-exact pin must fail rather than pass unchecked");
  }

  // 8 — end to end through the CLI entrypoint, on the F-1132 fixture.
  {
    const root = fixtureRoot(
      { "@pome-sh/twin-github": "0.4.0", "@pome-sh/sdk": "0.7.0" },
      { "twin-github": "0.5.0", sdk: "0.8.0" },
    );
    const r = run(root);
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert(out.includes("@pome-sh/twin-github"), out);
    assert(out.includes("0.4.0") && out.includes("0.5.0"), `must name both versions: ${out}`);
  }

  // 9 — end to end, in sync.
  {
    const root = fixtureRoot({ "@pome-sh/sdk": "0.8.0" }, { sdk: "0.8.0" });
    const r = run(root);
    rmSync(root, { recursive: true, force: true });
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  }

  // 10 — this repo, right now. The gate must be green on main, or landing it
  // blocks every CLI release (the ticket's stated review risk).
  {
    const r = run(ROOT);
    assert(r.status === 0, `gate must pass on this repo: ${r.stdout}${r.stderr}`);
  }

  // 11 — a gate nothing runs is not a gate.
  {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    assert(
      /check-cli-pins-match-workspace\.mjs/.test(ci),
      "ci.yml must run the pin-parity gate",
    );
    assert(
      /check-cli-pins-match-workspace\.test\.mjs/.test(ci),
      "ci.yml must run this test file",
    );
  }

  console.log("✅ CLI pin-parity gate regression tests passed");
}

main();
