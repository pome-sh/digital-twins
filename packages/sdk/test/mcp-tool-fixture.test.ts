// SPDX-License-Identifier: Apache-2.0
//
// F-1325 — the shared MCP tool-table fixture loader.
//
// The point of the loader is that a tool name a twin serves cannot be typed
// into TypeScript: it comes from a fixture whose provenance is declared and
// whose bytes are hash-locked. These tests pin the three ways that guarantee
// can be hollowed out — an unhashed raw file, an undeclared provenance, and a
// code table that disagrees with the fixture in either direction.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  deriveCanonicalMcpToolListing,
  deriveMcpToolTable,
  diffServedToolsAgainstFixture,
  loadMcpToolFixture,
} from "../src/index.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const rawEnvelope = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        name: "list_widgets",
        description: "List widgets.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "create_widget",
        description: "Create a widget.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
  },
};

/** The bytes a `<name>.raw.json` holds: the envelope in compact JSON. */
const rawText = JSON.stringify(rawEnvelope);

function meta(overrides: Record<string, unknown> = {}) {
  return {
    twin: "widget",
    substrate: "live-wire-unauth",
    endpoint: "https://widgets.example/mcp",
    method: "tools/list",
    protocol: "JSON-RPC 2.0 over HTTP",
    protocolVersion: "2025-06-18",
    captureDate: "2026-08-06",
    rawFileSha256: sha256(rawText),
    canonicalFileSha256: sha256("placeholder"),
    liveToolCount: 2,
    liveToolOrder: ["list_widgets", "create_widget"],
    configuration: { auth: "none", completeness: "exact" },
    files: { raw: "mcp-tools-list.raw.json", canonical: "mcp-tools-list.canonical.json" },
    ...overrides,
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  return loadMcpToolFixture({ raw: JSON.parse(rawText), meta: meta(overrides) });
}

describe("loadMcpToolFixture", () => {
  it("returns the declared tools in the raw listing's order", () => {
    const loaded = fixture();
    expect(loaded.toolNames).toEqual(["list_widgets", "create_widget"]);
    expect(loaded.tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(loaded.meta.substrate).toBe("live-wire-unauth");
  });

  it("refuses a raw listing whose bytes do not hash to meta.rawFileSha256", () => {
    const edited = JSON.parse(rawText);
    edited.result.tools[0].name = "list_widgetz";
    expect(() => loadMcpToolFixture({ raw: edited, meta: meta() })).toThrow(
      /rawFileSha256/
    );
  });

  it("refuses a meta whose rawFileSha256 was hand-typed", () => {
    expect(() =>
      loadMcpToolFixture({ raw: JSON.parse(rawText), meta: meta({ rawFileSha256: "0".repeat(64) }) })
    ).toThrow(/rawFileSha256/);
  });

  it("refuses a meta missing a provenance field", () => {
    const incomplete = meta();
    delete (incomplete as Record<string, unknown>).protocolVersion;
    expect(() => loadMcpToolFixture({ raw: JSON.parse(rawText), meta: incomplete })).toThrow(
      /protocolVersion/
    );
  });

  it("refuses an unknown substrate rather than treating it as captured", () => {
    expect(() =>
      loadMcpToolFixture({ raw: JSON.parse(rawText), meta: meta({ substrate: "vibes" }) })
    ).toThrow(/substrate/);
  });

  it("requires the assumed configuration on an OSS substrate", () => {
    const noConfig = meta({ substrate: "oss-source" });
    delete (noConfig as Record<string, unknown>).configuration;
    expect(() => loadMcpToolFixture({ raw: JSON.parse(rawText), meta: noConfig })).toThrow(
      /configuration/
    );
  });

  it("requires a transcription record on a twin-owned substrate", () => {
    expect(() =>
      loadMcpToolFixture({ raw: JSON.parse(rawText), meta: meta({ substrate: "twin-code-transcription" }) })
    ).toThrow(/transcription/);
  });

  it("accepts a twin-owned substrate that declares what it is", () => {
    const loaded = loadMcpToolFixture({
      raw: JSON.parse(rawText),
      meta: meta({
        substrate: "twin-code-transcription",
        transcription: {
          readFrom: "this twin's own tools/list",
          contentOrigin: "src/tools.ts",
          comparedToUpstream: "never",
        },
      }),
    });
    expect(loaded.meta.substrate).toBe("twin-code-transcription");
  });

  it("refuses a liveToolOrder that disagrees with the raw listing", () => {
    expect(() =>
      loadMcpToolFixture({
        raw: JSON.parse(rawText),
        meta: meta({ liveToolOrder: ["create_widget", "list_widgets"] }),
      })
    ).toThrow(/liveToolOrder/);
  });

  it("refuses a tool carrying a field the wire projection would silently drop", () => {
    const extended = JSON.parse(rawText);
    extended.result.tools[0].deprecated = true;
    const text = JSON.stringify(extended);
    expect(() =>
      loadMcpToolFixture({ raw: extended, meta: meta({ rawFileSha256: sha256(text) }) })
    ).toThrow(/deprecated/);
  });
});

describe("deriveMcpToolTable", () => {
  const impls = {
    list_widgets: { schema: z.object({}), mutation: false, handler: () => ({ widgets: [] }) },
    create_widget: { schema: z.object({ name: z.string() }), mutation: true, handler: () => ({ ok: true }) },
  };

  it("takes name, description, inputSchema and annotations from the fixture", () => {
    const table = deriveMcpToolTable(fixture(), impls);
    expect(table.map((tool) => tool.name)).toEqual(["list_widgets", "create_widget"]);
    expect(table[0].description).toBe("List widgets.");
    expect(table[0].annotations).toEqual({ readOnlyHint: true });
    expect(table[1].inputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(table[1].mutation).toBe(true);
  });

  it("omits annotations, outputSchema and title when the fixture omits them", () => {
    const table = deriveMcpToolTable(fixture(), impls);
    expect("annotations" in table[1]).toBe(false);
    expect("outputSchema" in table[1]).toBe(false);
    expect("title" in table[1]).toBe(false);
  });

  it("refuses a fixture tool with no implementation", () => {
    const { list_widgets: _dropped, ...partial } = impls;
    expect(() => deriveMcpToolTable(fixture(), partial)).toThrow(/list_widgets/);
  });

  it("refuses an implementation the fixture does not declare", () => {
    expect(() =>
      deriveMcpToolTable(fixture(), { ...impls, delete_widget: impls.create_widget })
    ).toThrow(/delete_widget/);
  });

  it("applies table-wide defaults without overriding a fixture value", () => {
    const table = deriveMcpToolTable(fixture(), impls, {
      outputSchema: { type: "object", additionalProperties: true },
      includeIsError: true,
    });
    expect(table[0].outputSchema).toEqual({ type: "object", additionalProperties: true });
    expect(table[0].includeIsError).toBe(true);
  });
});

describe("diffServedToolsAgainstFixture", () => {
  const served = rawEnvelope.result.tools;

  it("is silent when the served listing equals the fixture", () => {
    expect(diffServedToolsAgainstFixture(served, fixture())).toEqual([]);
  });

  it("names a tool the twin serves but the fixture does not declare", () => {
    const extra = [...served, { name: "delete_widget", description: "x", inputSchema: {} }];
    expect(diffServedToolsAgainstFixture(extra, fixture()).join("\n")).toMatch(/delete_widget/);
  });

  it("names a fixture tool the twin does not serve", () => {
    expect(diffServedToolsAgainstFixture([served[0]], fixture()).join("\n")).toMatch(
      /create_widget/
    );
  });

  it("names a description the twin rewrote", () => {
    const drifted = structuredClone(served) as Array<{ description: string }>;
    drifted[0].description = "List the widgets.";
    expect(diffServedToolsAgainstFixture(drifted, fixture()).join("\n")).toMatch(
      /list_widgets.*description/s
    );
  });

  it("names an inputSchema the twin narrowed", () => {
    const drifted = structuredClone(served) as Array<{ inputSchema: Record<string, unknown> }>;
    delete drifted[0].inputSchema.additionalProperties;
    expect(diffServedToolsAgainstFixture(drifted, fixture()).join("\n")).toMatch(
      /list_widgets.*inputSchema/s
    );
  });
});

describe("deriveCanonicalMcpToolListing", () => {
  it("re-derives the canonical bytes from the raw envelope and the provenance", () => {
    const canonical = deriveCanonicalMcpToolListing({ raw: JSON.parse(rawText), meta: meta() });
    const parsed = JSON.parse(canonical) as {
      meta: Record<string, unknown>;
      result: { tools: unknown[] };
    };
    expect(canonical.endsWith("\n")).toBe(true);
    expect(parsed.result.tools).toEqual(rawEnvelope.result.tools);
    expect(parsed.meta.derivedFrom).toBe("mcp-tools-list.raw.json");
    // The self-referential fields stay out of the hashed bytes.
    expect(parsed.meta.canonicalFileSha256).toBeUndefined();
    expect(parsed.meta.files).toBeUndefined();
  });
});
