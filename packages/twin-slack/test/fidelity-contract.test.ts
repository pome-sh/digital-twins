// SPDX-License-Identifier: Apache-2.0
//
// Fidelity contract (F-730): the structured inventory is the hub — it must
// match the live tool list exactly, and the FIDELITY.md tables must match
// the inventory 1:1 (tier included). This replaces the old soft "docs
// mention the tool name" check, which could not see undocumented surfaces.
// The slack-specific doc pins (tier vocabulary, required REST surfaces, ts
// invariant, mutating tool set) stay.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToolNames,
  lintFidelityInventory,
  loadFidelityInventory,
} from "@pome-sh/sdk/parity";
import { MUTATING_TOOL_NAMES, slackToolFixture } from "../src/tools.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIDELITY_PATH = join(PKG_ROOT, "FIDELITY.md");

describe("FIDELITY.md contract", () => {
  it("FIDELITY.md exists in the package root", () => {
    expect(existsSync(FIDELITY_PATH)).toBe(true);
  });

  it("keeps fidelity.inventory.json 1:1 with the tool-table fixture", () => {
    const inventory = loadFidelityInventory(join(PKG_ROOT, "fidelity.inventory.json"));
    expect(
      compareToolNames(
        inventory.tools.map((tool) => tool.name),
        [...slackToolFixture.toolNames]
      )
    ).toEqual({ missing: [], extra: [] });
  });

  it("keeps the FIDELITY.md tables 1:1 with fidelity.inventory.json", () => {
    const inventory = loadFidelityInventory(join(PKG_ROOT, "fidelity.inventory.json"));
    const body = readFileSync(FIDELITY_PATH, "utf8");
    expect(
      lintFidelityInventory(inventory, [
        { label: "FIDELITY.md", kind: "tool", markdown: body },
        { label: "FIDELITY.md", kind: "rest", markdown: body },
      ])
    ).toEqual([]);
  });

  it("FIDELITY.md declares the three fidelity tiers", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    expect(body).toMatch(/`semantic`/);
    expect(body).toMatch(/`shape`/);
    expect(body).toMatch(/`unsupported`/);
  });

  it("FIDELITY.md references all 12 fidelity-required REST surfaces", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    const required = [
      "auth.test",
      "chat.postMessage",
      "chat.update",
      "chat.delete",
      "conversations.list",
      "conversations.info",
      "conversations.create",
      "conversations.history",
      "conversations.replies",
      "reactions.add",
      "users.list",
      "users.profile.get",
    ];
    for (const route of required) {
      expect(body.includes("`" + route + "`"), `FIDELITY.md is missing the route '${route}'`).toBe(true);
    }
  });

  it("FIDELITY.md documents the workspace-unique ts invariant", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    expect(body).toMatch(/workspace-globally-unique/);
  });

  it("FIDELITY.md documents the mutating MCP tool set", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    for (const name of MUTATING_TOOL_NAMES) {
      expect(body.includes(name)).toBe(true);
    }
  });
});

// Heat discipline (F-736): every surface carries its ruled heat tier and the
// exact target mapping from packages/sdk/ENDPOINT-TIERS.md holds — hot must
// be semantic (F-736 filled the last hot gaps), cold must be unsupported,
// and warm surfaces sitting above their shape target must each appear in
// FIDELITY.md's tier-mismatch ledger (M5 additive-only ruling: visible in
// the ledger, never demoted in code).
describe("heat tiers (F-729 ruling, F-736 re-cut)", () => {
  const inventory = loadFidelityInventory(join(PKG_ROOT, "fidelity.inventory.json"));
  const surfaces = [...inventory.tools, ...inventory.rest];

  function ledgerSection(): string {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    const start = body.indexOf("## Tier-mismatch ledger");
    expect(start, "FIDELITY.md is missing the '## Tier-mismatch ledger' section").toBeGreaterThan(-1);
    const rest = body.slice(start + 1);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("no surface is left unclassified", () => {
    const unclassified = surfaces.filter((s) => s.heat === "unclassified").map((s) => s.name);
    expect(unclassified).toEqual([]);
  });

  it("every justification cites a rubric evidence code", () => {
    for (const surface of surfaces) {
      expect(
        /\b(TC|MCP|TR|SB|PS)\b/.test(surface.justification),
        `'${surface.name}' justification cites no ENDPOINT-TIERS.md evidence code`
      ).toBe(true);
    }
  });

  it("hot surfaces are all semantic (no open hot gaps after F-736)", () => {
    const gaps = surfaces.filter((s) => s.heat === "hot" && s.fidelity !== "semantic");
    expect(gaps.map((s) => s.name)).toEqual([]);
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

describe("state-shape parity", () => {
  // `check-state.ts` is a hand-written TOLERANT READER of raw SQLite rows —
  // `exportState()` is a set of `SELECT *` dumps, so nothing makes the model and
  // the export agree. The parity harness's three rings (live tool list,
  // fidelity.inventory.json, scenario coverage) are all about the TOOL surface;
  // this is the arm that was missing, and its absence is why pome-cloud's
  // hand-maintained mirror of this shape could drift for a milestone with
  // nothing to notice.
  //
  // It lives in the file that already runs rather than in a new gate, which is
  // F-1126's instruction: reuse the parity harness, do not build a second drift
  // gate.
  const exported = (): Record<string, unknown> => {
    const db = openSlackTwinDatabase(":memory:");
    const domain = new SlackDomain(db);
    domain.applySeed(defaultSeedState());
    return domain.exportState() as Record<string, unknown>;
  };

  it("finds every top-level key SlackCheckState names", () => {
    const state = exported();
    for (const key of ["channels", "reactions"]) {
      expect(state, `exportState() no longer produces "${key}"`).toHaveProperty(key);
    }
  });

  it("finds every channel field the model reads, on a real exported row", () => {
    const channels = exported().channels as Record<string, unknown>[];
    expect(channels.length).toBeGreaterThan(0);
    for (const field of ["id", "name", "is_private", "is_group", "is_im", "is_mpim", "messages"]) {
      expect(channels[0]!, `exportState() channels no longer carry "${field}"`).toHaveProperty(field);
    }
  });

  it("confirms is_private really arrives as an INTEGER, not a boolean", () => {
    // The trap `check-state.ts` documents. If the twin ever normalises this to a
    // boolean, `isPublicChannel` still works (it accepts both) but the comment
    // becomes a lie — and the next reader writes `=== 1` against a boolean.
    const channels = exported().channels as Record<string, unknown>[];
    expect(typeof channels[0]!.is_private).toBe("number");
  });

  it("finds every message field the model reads", () => {
    const channels = exported().channels as Record<string, unknown>[];
    const withMessages = channels.find(
      (channel) => (channel.messages as unknown[]).length > 0,
    );
    expect(withMessages, "the default seed has no message to check the shape against").toBeTruthy();
    const message = (withMessages!.messages as Record<string, unknown>[])[0]!;
    for (const field of ["ts", "user_id", "text"]) {
      expect(message, `exportState() messages no longer carry "${field}"`).toHaveProperty(field);
    }
  });

  it("finds every reaction field the model reads, and confirms they are TOP-LEVEL", () => {
    // Reactions are keyed by `channel_id` in a flat list, not nested under their
    // channel. A predicate that assumed nesting would silently find none.
    const db = openSlackTwinDatabase(":memory:");
    const domain = new SlackDomain(db);
    domain.applySeed({
      ...defaultSeedState(),
      channels: [
        {
          id: "C_GENERAL",
          name: "general",
          is_private: false,
          topic: "",
          purpose: "",
          members: ["U_PRIMARY"],
          messages: [
            { user: "U_PRIMARY", text: "ship it", reactions: [{ name: "tada", user: "U_PRIMARY" }] },
          ],
        },
      ],
    });
    const reactions = domain.exportState().reactions as Record<string, unknown>[];
    expect(reactions.length).toBeGreaterThan(0);
    for (const field of ["channel_id", "message_ts", "name", "user_id"]) {
      expect(reactions[0]!, `exportState() reactions no longer carry "${field}"`).toHaveProperty(field);
    }
  });
});
