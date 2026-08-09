// SPDX-License-Identifier: Apache-2.0
//
// Structured fidelity inventory (F-730). Each twin ships a machine-readable
// surface list — `fidelity.inventory.json` — carrying, per MCP tool and REST
// surface, the heat tier (how deep the endpoint SHOULD be, ruled by the
// F-729 rubric) orthogonal to the fidelity tier (how deep it IS, per
// `fidelityTierSchema`), plus a justification for the classification.
//
// The FIDELITY doc tables are 1:1-linted against this inventory instead of
// the old soft "docs mention the tool name" checks (which let twin-stripe's
// implemented-but-undocumented refunds drift by silently). Known, ticketed
// doc gaps are declared in `doc_drift`: the lint accepts exactly those
// gaps and fails loudly once the docs catch up, so a declaration can never
// outlive the drift it describes.
//
// That lint compares two DOCUMENTS. `lintFidelityRestRoutes` (F-1368) is the
// arm that compares the `rest` half to the code: the routes the twin actually
// registers, in both directions, so a route can no longer be added or removed
// with the inventory staying green.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { fidelityTierSchema } from "./index.js";

export const heatTierSchema = z.enum(["hot", "warm", "cold", "unclassified"]);
export type HeatTier = z.infer<typeof heatTierSchema>;

export const fidelitySurfaceSchema = z.strictObject({
  /** MCP tool name, or the REST surface string exactly as documented. */
  name: z.string().min(1),
  heat: heatTierSchema,
  fidelity: fidelityTierSchema,
  justification: z.string().min(1),
});
export type FidelitySurface = z.infer<typeof fidelitySurfaceSchema>;

/**
 * Why a `rest` row stands for none of the routes the twin registers (F-1368).
 *
 * Both kinds are real rows about real behaviour — they are simply not answered
 * by a route in the twin's own declared set, so the 1:1 comparison has to be
 * told which and why rather than being handed a count that does not line up.
 */
export const fidelityUnregisteredSchema = z.strictObject({
  kind: z.enum([
    // Served, but by the engine rather than by this twin's route registrar —
    // the MCP transport rows. Outside the declared set by construction, and a
    // twin declaring them would publish the engine's surface as its own.
    "engine",
    // Served by nobody. The row documents a surface the twin deliberately does
    // not implement; the loud-501 catch-all is what answers it.
    "unserved",
  ]),
  reason: z.string().min(1),
});
export type FidelityUnregistered = z.infer<typeof fidelityUnregisteredSchema>;

/**
 * A `rest` row, plus the link from its DOCUMENTATION name to the router
 * patterns that name is about.
 *
 * The two spellings are allowed to differ, and should be: a row names one
 * vendor surface the way the vendor documents it (`GET /repos/:owner/:repo/
 * branches/:branch`), while the router spells the same thing the way hono
 * matches it (`.../branches/*`), sometimes across two patterns. Forcing the
 * row to carry the router's spelling would degrade the document to satisfy a
 * linter. So the row carries the link instead, and
 * `lintFidelityRestRoutes` checks it in both directions.
 */
export const fidelityRestSurfaceSchema = fidelitySurfaceSchema.extend({
  /**
   * The route surfaces (`"<METHOD> <path>"`, exactly as the declaration spells
   * them) this row accounts for. Omitted means the row's own `name` IS the
   * surface, which is the common case. Never a list of DIFFERENT vendor
   * endpoints: an umbrella row hides every surface under it from the count,
   * which is the failure F-1368 is about.
   */
  routes: z.array(z.string().min(1)).min(1).optional(),
  unregistered: fidelityUnregisteredSchema.optional(),
});
export type FidelityRestSurface = z.infer<typeof fidelityRestSurfaceSchema>;

export const fidelityDocDriftSchema = z.strictObject({
  kind: z.enum(["tool", "rest"]),
  /** Must match an inventory entry of the same kind. */
  name: z.string().min(1),
  reason: z.string().min(1),
  /** The Linear ticket that owns reconciling the docs. */
  ticket: z.string().regex(/^F-\d+$/),
});
export type FidelityDocDrift = z.infer<typeof fidelityDocDriftSchema>;

export const fidelityInventorySchema = z.strictObject({
  twin: z.string().min(1),
  package: z.string().min(1),
  /** ISO date (YYYY-MM-DD) of the last human review of this inventory. */
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  tools: z.array(fidelitySurfaceSchema).min(1),
  rest: z.array(fidelityRestSurfaceSchema),
  doc_drift: z.array(fidelityDocDriftSchema).default([]),
});
export type FidelityInventory = z.infer<typeof fidelityInventorySchema>;

export function loadFidelityInventory(path: string): FidelityInventory {
  return fidelityInventorySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

// ─── FIDELITY doc table parsing ──────────────────────────────────────────────

export interface FidelityDocRow {
  name: string;
  fidelity: string;
  /** Present only when the table carries the optional Heat column. */
  heat?: string;
}

export interface FidelityDocSource {
  /** Shown in lint problems, e.g. "FIDELITY.md". */
  label: string;
  kind: "tool" | "rest";
  markdown: string;
}

const TOOL_NAME_HEADERS = new Set(["tool"]);
const REST_NAME_HEADERS = new Set(["route", "endpoint", "surface"]);

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Expand one name cell into surface names. Backticked spans are the names;
 * a span with no `.`, `/`, or space is shorthand for a sibling of the first
 * span (Slack-style `` `reactions.add` / `remove` / `get` ``) and inherits
 * its dotted prefix. Cells with no backticks name the surface verbatim
 * (e.g. "Any unsupported path").
 */
export function expandSurfaceCell(cell: string): string[] {
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
  if (spans.length === 0) {
    const text = cell.trim();
    return text.length > 0 ? [text] : [];
  }
  const [first, ...rest] = spans;
  const lastDot = first.lastIndexOf(".");
  const prefix = lastDot >= 0 ? first.slice(0, lastDot + 1) : "";
  return [
    first,
    ...rest.map((span) =>
      /[./ ]/.test(span) || prefix === "" ? span : `${prefix}${span}`
    ),
  ];
}

/**
 * Parse every markdown table whose header names surfaces of `kind` + Tier.
 * The Heat column (ENDPOINT-TIERS.md) is optional: parsed when the header
 * names it, omitted otherwise, so pre-heat tables stay legal.
 */
export function parseFidelityDocRows(markdown: string, kind: "tool" | "rest"): FidelityDocRow[] {
  const nameHeaders = kind === "tool" ? TOOL_NAME_HEADERS : REST_NAME_HEADERS;
  const rows: FidelityDocRow[] = [];
  const lines = markdown.split("\n");
  let nameIdx = -1;
  let tierIdx = -1;
  let heatIdx = -1;
  let inTable = false;
  for (const line of lines) {
    if (!line.trimStart().startsWith("|")) {
      inTable = false;
      nameIdx = -1;
      tierIdx = -1;
      heatIdx = -1;
      continue;
    }
    const cells = splitTableRow(line);
    if (!inTable) {
      const headers = cells.map((cell) => cell.toLowerCase());
      nameIdx = headers.findIndex((header) => nameHeaders.has(header));
      tierIdx = headers.findIndex((header) => header === "tier");
      heatIdx = headers.findIndex((header) => header === "heat");
      inTable = true;
      continue;
    }
    if (isSeparatorRow(cells) || nameIdx < 0 || tierIdx < 0) continue;
    const fidelity = cells[tierIdx] ?? "";
    const heat = heatIdx >= 0 ? { heat: cells[heatIdx] ?? "" } : {};
    for (const name of expandSurfaceCell(cells[nameIdx] ?? "")) {
      rows.push({ name, fidelity, ...heat });
    }
  }
  return rows;
}

// ─── Lint: inventory ⇔ docs, both directions ─────────────────────────────────

/**
 * 1:1-lint the inventory against the FIDELITY doc tables. Returns human-
 * readable problems (empty = clean). Directions checked per kind:
 * every doc row must be in the inventory with the same fidelity tier, and
 * every inventory entry must be documented unless a `doc_drift` entry
 * (with its owning ticket) declares the gap. A drift declaration whose
 * name IS documented is stale and reported, so drift entries self-expire.
 */
export function lintFidelityInventory(
  inventory: FidelityInventory,
  docs: FidelityDocSource[]
): string[] {
  const problems: string[] = [];
  for (const kind of ["tool", "rest"] as const) {
    const sources = docs.filter((doc) => doc.kind === kind);
    if (sources.length === 0) continue;
    const labels = sources.map((doc) => doc.label).join(", ");
    const entries = kind === "tool" ? inventory.tools : inventory.rest;
    const drift = new Map(
      inventory.doc_drift.filter((d) => d.kind === kind).map((d) => [d.name, d])
    );

    const inventoryByName = new Map<string, FidelitySurface>();
    for (const entry of entries) {
      if (inventoryByName.has(entry.name)) {
        problems.push(`inventory ${kind} '${entry.name}' is listed twice`);
      }
      inventoryByName.set(entry.name, entry);
    }

    const documented = new Map<string, FidelityDocRow>();
    for (const source of sources) {
      for (const row of parseFidelityDocRows(source.markdown, kind)) {
        const existing = documented.get(row.name);
        if (existing && existing.fidelity !== row.fidelity) {
          problems.push(
            `${labels}: ${kind} '${row.name}' is documented twice with conflicting tiers ('${existing.fidelity}' vs '${row.fidelity}')`
          );
          continue;
        }
        if (
          existing &&
          existing.heat !== undefined &&
          row.heat !== undefined &&
          existing.heat !== row.heat
        ) {
          problems.push(
            `${labels}: ${kind} '${row.name}' is documented twice with conflicting heat ('${existing.heat}' vs '${row.heat}')`
          );
          continue;
        }
        documented.set(row.name, row);
      }
    }

    for (const [name, row] of documented) {
      const entry = inventoryByName.get(name);
      if (!entry) {
        problems.push(`${labels}: ${kind} '${name}' documented but missing from fidelity.inventory.json`);
        continue;
      }
      if (entry.fidelity !== row.fidelity) {
        problems.push(
          `${kind} '${name}': inventory says fidelity '${entry.fidelity}' but ${labels} says '${row.fidelity}'`
        );
      }
      if (row.heat !== undefined && entry.heat !== row.heat) {
        problems.push(
          `${kind} '${name}': inventory says heat '${entry.heat}' but ${labels} says '${row.heat}'`
        );
      }
    }

    for (const entry of entries) {
      if (documented.has(entry.name)) continue;
      const declared = drift.get(entry.name);
      if (!declared) {
        problems.push(
          `${kind} '${entry.name}' is in fidelity.inventory.json but undocumented in ${labels}; add the row or declare doc_drift`
        );
      }
    }

    for (const declared of drift.values()) {
      if (!inventoryByName.has(declared.name)) {
        problems.push(
          `doc_drift ${kind} '${declared.name}' (${declared.ticket}) matches no inventory entry`
        );
      }
      if (documented.has(declared.name)) {
        problems.push(
          `doc_drift ${kind} '${declared.name}' (${declared.ticket}) is stale — ${labels} now documents it; remove the declaration`
        );
      }
    }
  }
  return problems;
}

// ─── Lint: rest rows ⇔ the routes the twin really registers ──────────────────

/**
 * 1:1-lint the `rest` rows against the twin's own route surfaces (F-1368).
 *
 * `lintFidelityInventory` above diffs the inventory against the FIDELITY doc
 * tables, so the two documents agree with each other — and neither is compared
 * to the code that serves traffic. A route could be added to or removed from a
 * twin and both stayed green. The inventory is the denominator every fidelity
 * lane counts against, so an unverified one makes a surface INVISIBLE rather
 * than `not-compared`: nothing anywhere says it was never measured.
 *
 * `registered` is the twin's route surfaces (`"<METHOD> <path>"`), which for
 * every twin is `<TWIN>_ROUTE_INPUTS.map((d) => d.surface)` — the declarations
 * the routes are literally mounted FROM (F-1179), pinned equal to the
 * registrar's calls and to the booted app's table by each twin's own
 * `route-input-declarations.test.ts`.
 *
 * Both directions are checked, and a row that resolves to no route has to say
 * why (`unregistered`) instead of being quietly skipped.
 */
export function lintFidelityRestRoutes(
  inventory: FidelityInventory,
  registered: readonly string[]
): string[] {
  const problems: string[] = [];
  const mounted = new Set(registered);
  /** Route surface → the rest rows accounting for it. */
  const claims = new Map<string, string[]>();

  for (const row of inventory.rest) {
    if (row.unregistered && row.routes) {
      problems.push(
        `rest '${row.name}' carries both \`routes\` and \`unregistered\` — a row either ` +
          `accounts for routes or says why it accounts for none, never both`
      );
      continue;
    }
    if (row.unregistered) {
      // Self-expiring, the way `doc_drift` is: the day the twin registers this
      // surface, the declaration that it registers nothing becomes a lie.
      if (mounted.has(row.name)) {
        problems.push(
          `rest '${row.name}' is declared unregistered ('${row.unregistered.kind}') but the twin ` +
            `registers exactly that surface; remove the declaration`
        );
      }
      continue;
    }
    for (const surface of row.routes ?? [row.name]) {
      if (!mounted.has(surface)) {
        problems.push(
          row.routes
            ? `rest '${row.name}' lists route '${surface}', which the twin does not register`
            : `rest '${row.name}' names no route the twin registers; add \`routes\` naming the ` +
              `surface(s) it stands for, or \`unregistered\` saying why it stands for none`
        );
        continue;
      }
      claims.set(surface, [...(claims.get(surface) ?? []), row.name]);
    }
  }

  for (const surface of new Set(registered)) {
    const claimed = claims.get(surface);
    if (!claimed) {
      problems.push(`route '${surface}' is registered but absent from fidelity.inventory.json`);
      continue;
    }
    if (claimed.length > 1) {
      problems.push(
        `route '${surface}' is accounted for by ${claimed.length} rest rows ` +
          `(${claimed.map((name) => `'${name}'`).join(", ")}); exactly one row owns a route`
      );
    }
  }
  return problems;
}

/** Set-compare tool names: inventory vs the tool-table fixture. */
export function compareToolNames(
  inventoryNames: string[],
  liveNames: string[]
): { missing: string[]; extra: string[] } {
  const inventory = new Set(inventoryNames);
  const live = new Set(liveNames);
  return {
    missing: [...live].filter((name) => !inventory.has(name)).sort(),
    extra: [...inventory].filter((name) => !live.has(name)).sort(),
  };
}
