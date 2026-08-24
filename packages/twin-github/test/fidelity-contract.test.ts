// SPDX-License-Identifier: Apache-2.0
// Fidelity contract: the structured inventory is the hub — it must match the live tool
// list exactly, and the FIDELITY doc tables must match the inventory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareToolNames,
  lintFidelityInventory,
  lintFidelityRestRoutes,
  loadFidelityInventory,
} from "@pome-sh/sdk/parity";
import { GITHUB_ROUTE_INPUTS } from "../src/route-inputs.js";
import { githubToolFixture } from "../src/tools.js";

const root = resolve(import.meta.dirname, "..");
const inventory = loadFidelityInventory(resolve(root, "fidelity.inventory.json"));
const fidelity = readFileSync(resolve(root, "FIDELITY.md"), "utf8");
const matrix = readFileSync(resolve(root, "FIDELITY_MATRIX.md"), "utf8");

describe("fidelity contract documentation", () => {
  it("keeps fidelity.inventory.json 1:1 with the live tool list", () => {
    expect(
      compareToolNames(
        inventory.tools.map((tool) => tool.name),
        [...githubToolFixture.toolNames]
      )
    ).toEqual({ missing: [], extra: [] });
  });

  it("keeps the FIDELITY doc tables 1:1 with fidelity.inventory.json", () => {
    expect(
      lintFidelityInventory(inventory, [
        { label: "FIDELITY.md", kind: "tool", markdown: fidelity },
        { label: "FIDELITY_MATRIX.md", kind: "rest", markdown: matrix },
      ])
    ).toEqual([]);
  });

  it("keeps fidelity.inventory.json's rest rows 1:1 with the routes the twin mounts", () => {
    // The lint above compares two DOCUMENTS — the inventory and FIDELITY_MATRIX.md —
    // so they agreed with each other and with nothing that serves traffic; 62.
    expect(
      lintFidelityRestRoutes(
        inventory,
        GITHUB_ROUTE_INPUTS.map((declaration) => declaration.surface)
      )
    ).toEqual([]);
  });

  it("documents the fidelity tier vocabulary and a verification date", () => {
    expect(fidelity).toContain("semantic");
    expect(fidelity).toContain("shape");
    expect(fidelity).toContain("unsupported");
    expect(fidelity).toContain("Last verified");
  });

  it("keeps a route-level matrix for product-supported REST behavior", () => {
    for (const surface of [
      "`GET /repos/:owner/:repo`",
      "`POST /repos/:owner/:repo/issues`",
      "`GET /repos/:owner/:repo/collaborators/:username`",
      "`POST /mcp/call`"
    ]) {
      expect(matrix).toContain(surface);
    }
    expect(matrix).toContain("unsupported");
    expect(matrix).toContain("Last verified");
  });
});

// Heat discipline (mirroring the twin-slack pass): every surface carries its ruled
// heat tier and the exact target mapping from packages/sdk/ENDPOINT-TIERS.md.
describe("heat tiers (heat ruling)", () => {
  const surfaces = [...inventory.tools, ...inventory.rest];
  const ENGINE_INTROSPECTION = ["POST /mcp/call", "POST /mcp/tools/:name"];
  // The MCP half of G1 left the inventory: `get_pull_request_diff` is not a tool
  // GitHub declares, and its replacement `pull_request_read` carries the placeholder-patch.
  const DEFERRED_HOT_GAPS = ["GET /repos/:owner/:repo/pulls/:number/diff"];

  function ledgerSection(): string {
    const start = fidelity.indexOf("## Tier-mismatch ledger");
    expect(start, "FIDELITY.md is missing the '## Tier-mismatch ledger' section").toBeGreaterThan(-1);
    const rest = fidelity.slice(start + 1);
    // Stop before the "### Hot-gap deferrals" subsection — those are gaps
    // (below target), not ledger entries (above target).
    const end = Math.min(...["\n## ", "\n### "].map((h) => rest.indexOf(h)).filter((i) => i !== -1));
    return Number.isFinite(end) ? rest.slice(0, end) : rest;
  }

  it("only the engine-introspection rows are unclassified", () => {
    const unclassified = surfaces.filter((s) => s.heat === "unclassified").map((s) => s.name);
    expect(unclassified.sort()).toEqual([...ENGINE_INTROSPECTION].sort());
  });

  it("every classified justification cites a rubric evidence code", () => {
    for (const surface of surfaces) {
      if (ENGINE_INTROSPECTION.includes(surface.name)) continue;
      expect(
        /\b(TC|MCP|TR|SB|PS)\b/.test(surface.justification),
        `'${surface.name}' justification cites no ENDPOINT-TIERS.md evidence code`
      ).toBe(true);
    }
  });

  it("hot surfaces are semantic except the explicitly deferred G1 gap", () => {
    const gaps = surfaces.filter((s) => s.heat === "hot" && s.fidelity !== "semantic");
    expect(gaps.map((s) => s.name).sort()).toEqual([...DEFERRED_HOT_GAPS].sort());
    for (const gap of gaps) {
      expect(
        /deferred/i.test(gap.justification),
        `hot gap '${gap.name}' carries no explicit defer note`
      ).toBe(true);
    }
  });

  it("named cold surfaces are all unsupported", () => {
    const mismatches = surfaces.filter((s) => s.heat === "cold" && s.fidelity !== "unsupported");
    expect(mismatches.map((s) => s.name)).toEqual([]);
  });

  it("warm surfaces above their shape target each appear in the tier-mismatch ledger", () => {
    const ledger = ledgerSection();
    const overTarget = surfaces.filter((s) => s.heat === "warm" && s.fidelity === "semantic");
    expect(overTarget.length).toBeGreaterThan(0);
    for (const surface of overTarget) {
      expect(
        ledger.includes("`" + surface.name + "`"),
        `warm surface '${surface.name}' is above its shape target but missing from the ledger`
      ).toBe(true);
    }
  });

  it("the ledger names no surface that is actually at or below target", () => {
    const ledger = ledgerSection();
    const atTarget = surfaces.filter((s) => !(s.heat === "warm" && s.fidelity === "semantic"));
    for (const surface of atTarget) {
      expect(
        ledger.includes("`" + surface.name + "`"),
        `'${surface.name}' is at/below target but listed in the ledger`
      ).toBe(false);
    }
  });
});
