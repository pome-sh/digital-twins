// SPDX-License-Identifier: Apache-2.0
//
// meta.json version-reporting regression suite (D18.1 / F-689, D10).
//
// CRITICAL CONTRACT: pome-cloud's ingest reads `meta.json.twin_versions` to
// validate a run and to attribute its captured behavior to the exact twin build
// that produced it. The old implementation resolved those versions at runtime
// through `createRequire(...).resolve("@pome-sh/twin-<id>")`; that was replaced
// by a build-time inline in each `TWIN_REGISTRY` entry so it survives bundling.
//
// If that swap regressed, nothing throws — cloud just silently records wrong or
// missing provenance for every run. So these tests assert the OUTPUT against an
// independent source of truth: the twin packages' own package.json files, read
// off disk here. The reported values must stay identical to what runtime
// resolution produced.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  META_SPEC_VERSION,
  resolveTwinPackageVersions,
} from "../../../src/recorder/specMeta.js";
import { TWIN_NAME_LIST } from "../../../src/twin/registry.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** The twin's version as npm would report it — read straight off the workspace
 *  manifest, deliberately NOT through the registry under test. */
function manifestVersion(twinId: string): string {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", `twin-${twinId}`, "package.json"), "utf8"),
  ) as { name: string; version: string };
  expect(manifest.name).toBe(`@pome-sh/twin-${twinId}`);
  return manifest.version;
}

function cliVersion(): string {
  return (
    JSON.parse(readFileSync(join(REPO_ROOT, "cli", "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
}

describe("META_SPEC_VERSION", () => {
  it("is a positive integer (bump on a breaking meta.json shape change)", () => {
    expect(Number.isInteger(META_SPEC_VERSION)).toBe(true);
    expect(META_SPEC_VERSION).toBeGreaterThan(0);
  });
});

describe("resolveTwinPackageVersions — cloud-ingest provenance contract", () => {
  it("reports each twin's OWN package version, matching its manifest on disk", () => {
    for (const twin of TWIN_NAME_LIST) {
      expect(resolveTwinPackageVersions([twin])).toEqual({
        [twin]: manifestVersion(twin),
      });
    }
  });

  it("never collapses every twin onto the CLI's own version", () => {
    // The exact regression D10 names: after dropping the runtime resolver, an
    // implementation that reached for the CLI's version would still produce a
    // well-formed meta.json and silently mis-attribute every run.
    const versions = resolveTwinPackageVersions([...TWIN_NAME_LIST]);
    const cli = cliVersion();
    expect(TWIN_NAME_LIST.every((twin) => versions[twin] === cli)).toBe(false);
  });

  it("resolves every registered twin in one call, keyed by twin id", () => {
    const expected: Record<string, string> = {};
    for (const twin of TWIN_NAME_LIST) expected[twin] = manifestVersion(twin);
    expect(resolveTwinPackageVersions([...TWIN_NAME_LIST])).toEqual(expected);
  });

  it("preserves the caller's id order in the emitted key order", () => {
    const ids = ["linear", "github", "stripe"];
    expect(Object.keys(resolveTwinPackageVersions(ids))).toEqual(ids);
  });

  it("returns {} for an empty twin list", () => {
    expect(resolveTwinPackageVersions([])).toEqual({});
  });

  it("OMITS an unknown twin id (never fabricates a version)", () => {
    expect(resolveTwinPackageVersions(["not-a-real-twin"])).toEqual({});
  });

  it("multi-twin: includes every known twin and omits the unknown ones", () => {
    expect(resolveTwinPackageVersions(["github", "stripe", "ghost-twin"])).toEqual({
      github: manifestVersion("github"),
      stripe: manifestVersion("stripe"),
    });
  });

  it("emits plain semver strings — no range, tarball path or workspace marker", () => {
    for (const version of Object.values(resolveTwinPackageVersions([...TWIN_NAME_LIST]))) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
    }
  });
});
