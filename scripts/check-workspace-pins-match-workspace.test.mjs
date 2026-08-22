#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-workspace-pins-match-workspace.mjs` (F-1126,
// extended to `cli/` under F-1231).
//
// F-1231 investigated a 2026-08-03 failure where the CLI's build typechecked
// against a `@pome-sh/shared-types` version behind what `packages/` (and its
// own source) actually used — a pin that had drifted out from under it. That
// specific architecture (`cli-ci.yml`, `use-local-pome-tarballs.mjs`, an exact
// registry pin in `cli/package.json`) was deleted across `6369379` (#237) and
// `a3c9441` (#239) the day AFTER the ticket was filed: every
// internal `@pome-sh/*` dep, cli's included, became a workspace-resolved `"*"`,
// which npm always symlinks — so the specific "stale pin passes CI, breaks on
// publish" shape this gate is named for cannot recur through `cli/` today. What
// CAN recur is the thing #239 fixed being silently undone: nothing stopped
// `cli/package.json` from reintroducing an exact pin, because this gate held its
// own `packages/*` list. It now reads the root `workspaces` field instead, which
// is why case 7 (a `packages/*` package pinning a stale `@pome-sh/cli`) reds and
// case 8 asserts that field still names `cli` — every other case runs against a
// fixture with its own root manifest, so the gate is proven to fire on the shape
// rather than trusted to, but no fixture can prove it is aimed at the real tree.
//
// The failure class through `agent-examples/*`'s deliberately-published pins is a
// different rule (needs the registry, tolerates a pin equal to a version that
// simply has not published yet) and is NOT this suite's subject — see
// `scripts/check-example-pins-published.mjs` (F-1483) and its own regression
// suite, wired from `scripts/gate-examples.mjs`.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPinViolations } from "./check-workspace-pins-match-workspace.mjs";

/** Build a throwaway repo with the real root `workspaces` field the gate reads:
 * packages/<dir>/package.json for each entry, plus a cli/package.json (always
 * written, defaulting to a clean `"*"`-only manifest — the gate is entitled to
 * assume a declared workspace exists, and case 6 covers the case where it does
 * not). */
function fixture(packageManifests, cliManifest) {
  const root = mkdtempSync(join(tmpdir(), "workspace-pins-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*", "cli"] }, null, 2),
  );
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [dir, manifest] of Object.entries(packageManifests)) {
    const pkgDir = join(root, "packages", dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  }
  mkdirSync(join(root, "cli"), { recursive: true });
  writeFileSync(
    join(root, "cli", "package.json"),
    JSON.stringify(cliManifest ?? { name: "@pome-sh/cli", version: "0.23.19" }, null, 2),
  );
  return root;
}

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.error(`✗ ${name}\n  ${detail}`);
}

/** `mustSay` is asserted against the joined violations: a gate that reds for the
 * wrong reason, or that names one of the two versions and not the other, is not
 * the gate the PR describing it claims. */
function expectGate(name, root, expected, mustSay = []) {
  const violations = findPinViolations(root);
  const got = violations.length === 0 ? "green" : "red";
  if (got !== expected) {
    fail(name, `expected ${expected}, got ${got}\n${violations.join("\n")}`);
    return;
  }
  const joined = violations.join("\n");
  const missing = mustSay.filter((needle) => !joined.includes(needle));
  if (missing.length > 0) {
    fail(name, `message omits ${JSON.stringify(missing)}:\n  ${joined}`);
    return;
  }
  console.log(`✓ ${name}${violations.length ? "\n  " + violations.join("\n  ") : ""}`);
}

function expectThrows(name, root) {
  try {
    findPinViolations(root);
  } catch {
    console.log(`✓ ${name}`);
    return;
  }
  fail(name, "returned a verdict instead of throwing");
}

// 1. `"*"` everywhere (this repo's actual shape) is clean, in packages/ and cli/.
expectGate(
  "1. every pin is \"*\" — packages and cli",
  fixture(
    {
      sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
      "twin-github": {
        name: "@pome-sh/twin-github",
        version: "1.2.0",
        dependencies: { "@pome-sh/sdk": "*" },
      },
    },
    { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/sdk": "*" } },
  ),
  "green",
);

// 2. An exact pin that matches the sibling's version is still allowed (the
// existing packages/* rule, unchanged by this extension).
expectGate(
  "2. exact pin matching the sibling's version stays green",
  fixture({
    sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
    "twin-github": {
      name: "@pome-sh/twin-github",
      version: "1.2.0",
      dependencies: { "@pome-sh/sdk": "0.9.0" },
    },
  }),
  "green",
);

// 3. The original F-1126 shape: a packages/* sibling pins a stale exact version.
expectGate(
  "3. packages/* pin behind the workspace sibling reds (F-1126's own case)",
  fixture({
    sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
    "twin-slack": {
      name: "@pome-sh/twin-slack",
      version: "1.0.0",
      dependencies: { "@pome-sh/sdk": "0.5.1" },
    },
  }),
  "red",
  ["packages/twin-slack", "0.5.1", "0.9.0"],
);

// 4. The F-1231 regression this file exists for: `cli/package.json` pins an
// exact, stale version of a sibling instead of "*" — the exact shape #239
// deleted from `cli/` and that this gate's `packages/`-only scan could not see
// come back. `@pome-sh/wire`'s workspace version carries `parent_event_id`
// (0.14.0); a cli pinned to the pre-F-1200 line (0.13.x) is the 2026-08-03
// incident's own version numbers.
expectGate(
  "4. cli/package.json reintroducing a stale exact pin reds (the F-1231 regression)",
  fixture(
    { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
    { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/wire": "0.13.4" } },
  ),
  "red",
  ["cli", "0.13.4", "0.14.0"],
);

// 4b. Every other way a pin can be reintroduced is refused by the same rule, in
// every install field: a caret/tilde/range, a `file:`/`link:` path, a `npm:`
// alias, a dist-tag, a prerelease. Not because each one would resolve from the
// registry — `file:`/`link:` cannot, and `>=0.13.0` admits the sibling's current
// 0.14.0 — but because none of them keeps doing so across the sibling's next
// bump or directory move. `"*"` is the only form with no version in it at all.
// `optionalDependencies` resolves like `dependencies`, so it is scanned too.
for (const pin of [
  "^0.14.0",
  "~0.14.0",
  ">=0.13.0",
  "file:../packages/wire",
  "link:../packages/wire",
  "npm:@pome-sh/wire@0.13.4",
  "latest",
  "0.14.0-rc.1",
]) {
  expectGate(
    `4b. cli pin "${pin}" reds — "*" and an exact match are the only two forms`,
    fixture(
      { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
      { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/wire": pin } },
    ),
    "red",
  );
}
expectGate(
  "4c. a stale pin in optionalDependencies reds like one in dependencies",
  fixture(
    { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
    {
      name: "@pome-sh/cli",
      version: "0.23.19",
      optionalDependencies: { "@pome-sh/wire": "0.13.4" },
    },
  ),
  "red",
);

// 5. A `@pome-sh/*` cli dep with no sibling under packages/ (e.g. a future
// published-only dependency) is out of this gate's scope either way.
expectGate(
  "5. cli dep with no packages/ sibling is out of scope",
  fixture({}, { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/other": "1.0.0" } }),
  "green",
);

// 6. A workspace the root DECLARES but that has no manifest on disk must throw,
// not report a pass over what it did find. The old shape guarded `cli/` with
// `existsSync` and printed "every pin in packages/ and cli/ matches" either way,
// so relocating the CLI a third time would have silently reverted the gate to
// packages-only with nothing red.
{
  const root = mkdtempSync(join(tmpdir(), "workspace-pins-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*", "cli"] }),
  );
  expectThrows("6. a declared workspace with no manifest anywhere throws", root);
}

// 7. `cli` is a workspace member, so it is a SIBLING as well as a consumer: a
// `packages/*` package pinning a stale `@pome-sh/cli` would get a nested
// registry copy of the published CLI just as it would for the sdk. The
// hardcoded-list shape treated `cli` as a consumer only and waved this through
// as "no sibling in packages/, out of scope".
expectGate(
  "7. a packages/* package pinning a stale @pome-sh/cli reds — cli is a sibling too",
  fixture(
    {
      "twin-github": {
        name: "@pome-sh/twin-github",
        version: "1.0.0",
        dependencies: { "@pome-sh/cli": "0.23.18" },
      },
    },
    { name: "@pome-sh/cli", version: "0.23.19" },
  ),
  "red",
  ["packages/twin-github", "0.23.18", "0.23.19"],
);

// 8. The real repo, not a fixture. Every case above proves the LOGIC; this is
// the one that proves the logic is pointed at `cli/`, since the whole
// cli-coverage claim rests on `cli` still being a root workspace — drop it from
// that field and the gate stops scanning it while every fixture case above stays
// green, because each fixture writes its own root manifest.
{
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workspaces = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).workspaces;
  if (!workspaces?.includes("cli")) {
    fail("8. the real root `workspaces` still names `cli`", `got ${JSON.stringify(workspaces)}`);
  } else {
    console.log("8. the real root `workspaces` still names `cli`");
  }
  expectGate("8b. the real repo is clean", repoRoot, "green");
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll cases passed.");
