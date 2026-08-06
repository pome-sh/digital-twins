// SPDX-License-Identifier: Apache-2.0
//
// F-1325 — one substrate vocabulary, two validators.
//
// `substrate` is validated in two places: F-1326's capture producer
// (`scripts/capture-mcp-tools-list.mjs`, a root `.mjs` with its own registry)
// for the UPSTREAM goldens, and `mcpFixtureSubstrateSchema` here for the
// per-twin tool tables. Same field name, two languages, two trees, no import
// between them — which is how a vocabulary forks while both sides stay green.
// It had already started: an earlier draft of the enum carried `oss-package`,
// a value that existed nowhere else in the repo, and omitted `not-captured`,
// which is in live use in `config/mcp-capture-sources.json`.
//
// F-1327 reads both trees, so the rule is one-directional and checkable: the
// SDK enum must be a SUPERSET of the producer's registry. The SDK may add
// values the producer has no use for (`twin-code-transcription` and
// `twin-authored-from-vendor-docs` describe a table nobody read from upstream,
// which is not a thing a capture producer can produce); it may not drop or
// rename one the producer accepts.
//
// The import specifier is a variable so TypeScript does not try to resolve a
// `.mjs` outside this package's `rootDir`. The producer is import-safe: it
// gates its CLI on `process.argv[1]`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mcpFixtureSubstrateSchema, mcpToolFixtureMetaSchema } from "../src/index.js";

const repoRoot = new URL("../../../", import.meta.url);
const producerUrl = new URL("scripts/capture-mcp-tools-list.mjs", repoRoot).href;
const producer = (await import(producerUrl)) as { KNOWN_SUBSTRATES: readonly string[] };

describe("substrate vocabulary", () => {
  it("is a superset of the capture producer's registry", () => {
    const sdk = new Set<string>(mcpFixtureSubstrateSchema.options);
    const missing = producer.KNOWN_SUBSTRATES.filter((value) => !sdk.has(value));
    expect(
      missing,
      `the capture producer accepts ${missing.join(", ")} and this enum rejects it — ` +
        "the two validators of `substrate` have forked"
    ).toEqual([]);
  });

  it("declares no substrate the producer has never heard of unless it is twin-owned", () => {
    const producerValues = new Set(producer.KNOWN_SUBSTRATES);
    const extra = mcpFixtureSubstrateSchema.options.filter((value) => !producerValues.has(value));
    // Additions are legal, but only the twin-owned ones. A value that is
    // neither in the producer nor twin-owned is a phantom: nothing produces it
    // and nothing else in the repo can read it.
    expect(extra.sort()).toEqual(["twin-authored-from-vendor-docs", "twin-code-transcription"]);
  });

  // The point of sharing the vocabulary is that a golden the producer wrote can
  // be adopted as a twin's tool table without a translation layer. That is
  // exactly the migration F-1327 makes for github, so it is asserted rather
  // than assumed.
  it("parses F-1326's own upstream goldens through the per-twin meta schema", () => {
    for (const twin of ["gmail", "github"]) {
      const meta = JSON.parse(
        readFileSync(new URL(`fixtures/mcp-tools-list/${twin}.meta.json`, repoRoot), "utf8")
      ) as unknown;
      const parsed = mcpToolFixtureMetaSchema.safeParse(meta);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        `${twin}.meta.json must parse as a per-twin provenance record`
      ).toEqual([]);
    }
  });

  it("refuses an oss-source fixture that does not pin a commit", () => {
    const github = JSON.parse(
      readFileSync(new URL("fixtures/mcp-tools-list/github.meta.json", repoRoot), "utf8")
    ) as Record<string, unknown>;
    const { source: _dropped, ...unpinned } = github;
    expect(mcpToolFixtureMetaSchema.safeParse(unpinned).success).toBe(false);
  });

  it("refuses `not-captured` on a file that is itself a tool table", () => {
    const gmail = JSON.parse(
      readFileSync(new URL("fixtures/mcp-tools-list/gmail.meta.json", repoRoot), "utf8")
    ) as Record<string, unknown>;
    const parsed = mcpToolFixtureMetaSchema.safeParse({ ...gmail, substrate: "not-captured" });
    expect(parsed.success).toBe(false);
    expect(mcpFixtureSubstrateSchema.safeParse("not-captured").success).toBe(true);
  });
});
