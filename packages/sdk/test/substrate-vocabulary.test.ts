// SPDX-License-Identifier: Apache-2.0
// One substrate vocabulary, two validators.

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
    // Additions are legal, but each one has to be a thing this side can produce and
    // something else in the repo can read.
    expect(extra.sort()).toEqual([
      "twin-authored-from-vendor-docs",
      "twin-code-transcription",
      "upstream-capture-projection",
    ]);
  });

  // The substrate word is a claim; these are the two rules that make it cost something
  // to say.
  it("refuses an upstream-capture-projection that does not name what it projected from", () => {
    const projected = JSON.parse(
      readFileSync(new URL("packages/twin-github/fixtures/mcp-tools-list.meta.json", repoRoot), "utf8")
    ) as Record<string, unknown>;
    expect(mcpToolFixtureMetaSchema.safeParse(projected).success).toBe(true);
    const { projection: _dropped, ...unevidenced } = projected;
    expect(mcpToolFixtureMetaSchema.safeParse(unevidenced).success).toBe(false);
  });

  it("refuses a `projection` block on a substrate that projects nothing", () => {
    const projected = JSON.parse(
      readFileSync(new URL("packages/twin-github/fixtures/mcp-tools-list.meta.json", repoRoot), "utf8")
    ) as Record<string, unknown>;
    const parsed = mcpToolFixtureMetaSchema.safeParse({
      ...projected,
      substrate: "twin-code-transcription",
      transcription: {
        readFrom: "this twin",
        contentOrigin: "this twin's code",
        comparedToUpstream: "never",
      },
    });
    expect(parsed.success).toBe(false);
  });

  // The point of sharing the vocabulary is that a golden the producer wrote can be
  // adopted as a twin's tool table without a translation layer.
 it("parses the own upstream goldens through the per-twin meta schema", () => {
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
