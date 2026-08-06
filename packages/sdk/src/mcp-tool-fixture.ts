// SPDX-License-Identifier: Apache-2.0
//
// F-1325 — every twin derives its MCP tool table from a fixture.
//
// `twin-slack` served eight tool names that do not exist on Slack for as long
// as it existed: commit 6abec3c copied them out of an archived reference
// server into TypeScript, and nothing has read Slack's own `tools/list` since.
// A hand-written `toolDefinitions` array makes that mistake representable —
// and invisible. This module makes it unrepresentable: the served table comes
// from a fixture, the code supplies only handlers, and the two are checked
// 1:1 in both directions at module load.
//
// Three files per twin, the shape F-1326's upstream producer already uses:
//
//   <name>.raw.json        the verbatim `tools/list` envelope, compact JSON
//   <name>.meta.json       the provenance contract, validated here
//   <name>.canonical.json  raw re-derived with the provenance attached and
//                          whitespace a human can read a diff of
//
// `raw.json` is the file the twin imports and the file the hash covers. It is
// stored in the exact bytes `JSON.stringify()` produces, which is what lets
// `loadMcpToolFixture` verify the hash from the imported module — twins are
// bundled into the CLI, so a `readFileSync` at boot would resolve to nothing.
// The byte-level half of the same assertion (`sha256(raw.json bytes)`) is a
// filesystem test in each twin's suite; both check the same number.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolCallContext, ToolSpec } from "./index.js";

/**
 * How the bytes in a fixture came to be. The first four values are F-1326's
 * vocabulary for reading an UPSTREAM surface, reused verbatim rather than
 * forked. The last two describe a table nobody read from upstream at all, and
 * exist so that fact has to be stated instead of implied:
 *
 * - `twin-code-transcription` — the fixture is a transcription of the listing
 *   the twin's own code already served. It says nothing about the vendor.
 * - `twin-authored-from-vendor-docs` — the tool NAMES come from the vendor's
 *   published documentation; the schemas are the twin's own.
 *
 * A twin on either of the last two has never been compared to its upstream.
 * `transcription.comparedToUpstream` has to say so.
 */
export const mcpFixtureSubstrateSchema = z.enum([
  "live-wire-unauth",
  "live-wire-oauth",
  "oss-source",
  "oss-package",
  "twin-code-transcription",
  "twin-authored-from-vendor-docs",
]);
export type McpFixtureSubstrate = z.infer<typeof mcpFixtureSubstrateSchema>;

/** Substrates that read a real upstream deployment: which one is not optional. */
const UPSTREAM_SUBSTRATES = new Set<McpFixtureSubstrate>([
  "live-wire-unauth",
  "live-wire-oauth",
  "oss-source",
  "oss-package",
]);

/** Substrates whose content nobody read from upstream. */
const TWIN_OWNED_SUBSTRATES = new Set<McpFixtureSubstrate>([
  "twin-code-transcription",
  "twin-authored-from-vendor-docs",
]);

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256");

/**
 * What a fixture must say about itself before a twin is allowed to serve it.
 * `strictObject`: an unmodelled provenance key is a fact nothing validates, so
 * it reds here rather than sitting in the file looking authoritative.
 */
export const mcpToolFixtureMetaSchema = z
  .strictObject({
    twin: z.string().min(1),
    substrate: mcpFixtureSubstrateSchema,
    /** Where the listing was read from — a vendor URL, or the twin's own endpoint. */
    endpoint: z.string().min(1),
    method: z.literal("tools/list"),
    protocol: z.string().min(1),
    protocolVersion: z.string().min(1),
    captureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)"),
    rawFileSha256: sha256Hex,
    canonicalFileSha256: sha256Hex,
    liveToolCount: z.number().int().positive(),
    liveToolOrder: z.array(z.string().min(1)).min(1),
    /**
     * The configuration the substrate was read under. Mandatory on every
     * upstream substrate for F-1326's reason: the remote GitHub server serves
     * 44 tools at `/mcp/` and 85 at `/mcp/x/all`, so a capture that does not
     * say which one it read is an unstated assumption a consumer cannot argue
     * with.
     */
    configuration: z.record(z.string(), z.unknown()).optional(),
    /** Mandatory on twin-owned substrates: what this is, and what it is not. */
    transcription: z
      .strictObject({
        readFrom: z.string().min(1),
        contentOrigin: z.string().min(1),
        comparedToUpstream: z.string().min(1),
      })
      .optional(),
    notes: z.array(z.string()).optional(),
    files: z.strictObject({ raw: z.string().min(1), canonical: z.string().min(1) }),
  })
  .superRefine((meta, ctx) => {
    if (UPSTREAM_SUBSTRATES.has(meta.substrate) && !meta.configuration) {
      ctx.addIssue({
        code: "custom",
        path: ["configuration"],
        message:
          `substrate '${meta.substrate}' reads a real deployment, so the fixture must declare the ` +
          `configuration it assumed. A capture with no recorded configuration cannot be argued with.`,
      });
    }
    if (TWIN_OWNED_SUBSTRATES.has(meta.substrate) && !meta.transcription) {
      ctx.addIssue({
        code: "custom",
        path: ["transcription"],
        message:
          `substrate '${meta.substrate}' means nobody read this table from upstream, so the fixture ` +
          `must carry a transcription record saying where the content came from and that it has ` +
          `never been compared to the vendor.`,
      });
    }
  });
export type McpToolFixtureMeta = z.infer<typeof mcpToolFixtureMetaSchema>;

/**
 * One entry of a `tools/list` result. `strictObject` again, and for the same
 * reason the wire projection needs it: `mcp-jsonrpc.ts` emits exactly `name`,
 * `description`, `inputSchema`, `title`, `outputSchema` and `annotations`, so
 * a sixth key in a fixture would be silently dropped on the way to the wire
 * and the served listing would stop equalling its own oracle.
 */
export const canonicalMcpToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type CanonicalMcpTool = z.infer<typeof canonicalMcpToolSchema>;

const toolsListEnvelopeSchema = z.object({
  jsonrpc: z.string().min(1),
  id: z.union([z.string(), z.number()]),
  result: z.object({ tools: z.array(canonicalMcpToolSchema).min(1) }),
});

export interface McpToolFixtureModules {
  /** The parsed `<name>.raw.json` module. */
  raw: unknown;
  /** The parsed `<name>.meta.json` module. */
  meta: unknown;
}

export interface LoadedMcpToolFixture {
  meta: McpToolFixtureMeta;
  tools: readonly CanonicalMcpTool[];
  toolNames: readonly string[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Validate a twin's tool-table fixture and hand back the table it declares.
 *
 * Throws — at module load, before the twin can be defined — on a raw file
 * whose bytes disagree with `meta.rawFileSha256`, a provenance record missing
 * a declared field, or a `liveToolOrder` that no longer describes the listing.
 * A golden whose raw file was hand-edited must fail loudly rather than
 * silently become the new truth.
 */
export function loadMcpToolFixture(modules: McpToolFixtureModules): LoadedMcpToolFixture {
  const parsedMeta = mcpToolFixtureMetaSchema.safeParse(modules.meta);
  if (!parsedMeta.success) {
    throw new Error(
      `MCP tool fixture: invalid provenance in meta.json — ${issues(parsedMeta.error)}`
    );
  }
  const meta = parsedMeta.data;

  // The raw file is stored in exactly the bytes `JSON.stringify()` produces,
  // so re-serialising the imported module reproduces them. Any edit to the
  // listing changes this digest.
  const rawBytes = JSON.stringify(modules.raw);
  const actual = sha256(rawBytes);
  if (actual !== meta.rawFileSha256) {
    throw new Error(
      `MCP tool fixture (${meta.twin}): ${meta.files.raw} hashes to ${actual} but ` +
        `${meta.files.canonical.replace(/canonical\.json$/, "meta.json")} declares ` +
        `rawFileSha256 ${meta.rawFileSha256}. Either the raw listing was edited by hand or the sha ` +
        `was typed rather than computed; both are a change to what this twin serves.`
    );
  }

  const parsedRaw = toolsListEnvelopeSchema.safeParse(modules.raw);
  if (!parsedRaw.success) {
    throw new Error(
      `MCP tool fixture (${meta.twin}): ${meta.files.raw} is not a tools/list envelope — ${issues(parsedRaw.error)}`
    );
  }
  const tools = parsedRaw.data.result.tools;
  const toolNames = tools.map((tool) => tool.name);

  const duplicate = toolNames.find((name, index) => toolNames.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`MCP tool fixture (${meta.twin}): '${duplicate}' is declared twice`);
  }
  if (meta.liveToolCount !== tools.length) {
    throw new Error(
      `MCP tool fixture (${meta.twin}): meta declares liveToolCount ${meta.liveToolCount} but ` +
        `${meta.files.raw} carries ${tools.length} tools`
    );
  }
  if (meta.liveToolOrder.join(" ") !== toolNames.join(" ")) {
    throw new Error(
      `MCP tool fixture (${meta.twin}): meta.liveToolOrder no longer describes ${meta.files.raw}\n` +
        `  declared: ${meta.liveToolOrder.join(", ")}\n` +
        `  actual:   ${toolNames.join(", ")}`
    );
  }

  return { meta, tools, toolNames };
}

// ─── The tool table ──────────────────────────────────────────────────────────

/**
 * Everything about a tool that is a fact about THIS twin rather than about the
 * upstream listing: how to validate its arguments, whether it mutates local
 * state, and what to run. Its name, description, schema shape and annotations
 * are not here on purpose — those come from the fixture.
 */
export interface McpToolImplementation<TDomain> {
  schema: z.ZodType;
  /** Recorder truth for `state_mutation`, independent of upstream readOnlyHint. */
  mutation: boolean;
  handler: (domain: TDomain, args: never, ctx: ToolCallContext) => unknown;
  contentText?: (output: never) => string;
  outputSchema?: Record<string, unknown>;
  includeIsError?: boolean;
}

export interface DeriveMcpToolTableOptions {
  /** Applied to every tool the fixture does not give an `outputSchema`. */
  outputSchema?: Record<string, unknown>;
  /** Applied to every tool whose implementation does not set it. */
  includeIsError?: boolean;
}

/**
 * Join the fixture's declared listing to this twin's implementations, 1:1.
 *
 * A fixture tool with no implementation and an implementation the fixture does
 * not declare are both hard errors, thrown at module load. That symmetry is
 * the whole point: if a twin could serve a tool absent from its fixture, or
 * omit one present in it, the derivation would be decorative.
 */
export function deriveMcpToolTable<TDomain>(
  fixture: LoadedMcpToolFixture,
  implementations: Record<string, McpToolImplementation<TDomain>>,
  options: DeriveMcpToolTableOptions = {}
): ToolSpec<TDomain>[] {
  const declared = new Set(fixture.toolNames);
  const undeclared = Object.keys(implementations).filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      `MCP tool table (${fixture.meta.twin}): ${undeclared.join(", ")} ${undeclared.length === 1 ? "is" : "are"} ` +
        `implemented but absent from ${fixture.meta.files.raw}. The fixture is the tool table; add the ` +
        `tool there (with its provenance) or delete the implementation.`
    );
  }

  return fixture.tools.map((tool) => {
    const implementation = implementations[tool.name];
    if (!implementation) {
      throw new Error(
        `MCP tool table (${fixture.meta.twin}): ${fixture.meta.files.raw} declares '${tool.name}' and ` +
          `this twin implements no such tool.`
      );
    }
    const outputSchema = tool.outputSchema ?? implementation.outputSchema ?? options.outputSchema;
    const includeIsError = implementation.includeIsError ?? options.includeIsError;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      schema: implementation.schema as z.ZodType<unknown>,
      mutation: implementation.mutation,
      ...(implementation.contentText ? { contentText: implementation.contentText } : {}),
      ...(includeIsError !== undefined ? { includeIsError } : {}),
      handler: implementation.handler,
    } as ToolSpec<TDomain>;
  });
}

// ─── Served listing ⇔ fixture ────────────────────────────────────────────────

/**
 * Compare a `tools/list` result against the fixture that is supposed to have
 * produced it, field by field. Returns human-readable problems, empty when the
 * two agree. Used by each twin's own test to drive the real MCP surface: the
 * derivation is structural, but "structurally impossible" is a claim worth
 * one HTTP round trip.
 */
export function diffServedToolsAgainstFixture(
  served: unknown,
  fixture: LoadedMcpToolFixture
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(served)) {
    return [`tools/list did not answer an array of tools (got ${typeof served})`];
  }
  const servedByName = new Map<string, Record<string, unknown>>();
  for (const entry of served) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name !== "string") {
      problems.push(`tools/list carried an entry with no name: ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    servedByName.set(name, entry as Record<string, unknown>);
  }

  for (const name of servedByName.keys()) {
    if (!fixture.toolNames.includes(name)) {
      problems.push(
        `'${name}' is served but absent from ${fixture.meta.files.canonical} — the twin can serve a tool its fixture does not declare`
      );
    }
  }

  for (const tool of fixture.tools) {
    const entry = servedByName.get(tool.name);
    if (!entry) {
      problems.push(
        `'${tool.name}' is declared in ${fixture.meta.files.canonical} and not served`
      );
      continue;
    }
    for (const field of ["description", "inputSchema", "outputSchema", "annotations", "title"] as const) {
      const expected = tool[field];
      const actual = entry[field];
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        problems.push(
          `'${tool.name}' ${field} differs from the fixture\n` +
            `  fixture: ${JSON.stringify(expected)}\n` +
            `  served:  ${JSON.stringify(actual)}`
        );
      }
    }
  }

  const servedOrder = served
    .map((entry) => (entry as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === "string");
  if (problems.length === 0 && servedOrder.join(" ") !== fixture.toolNames.join(" ")) {
    problems.push(
      `tools/list order differs from the fixture\n  fixture: ${fixture.toolNames.join(", ")}\n  served:  ${servedOrder.join(", ")}`
    );
  }
  return problems;
}

// ─── Canonical derivation ────────────────────────────────────────────────────

/**
 * Re-derive `<name>.canonical.json` from the raw envelope and the provenance.
 * Same contract as F-1326's producer: canonical is DERIVED, never authored, so
 * a hand edit to it is caught by re-deriving and comparing bytes. The two
 * self-referential meta fields (`canonicalFileSha256`, `files`) stay out of the
 * hashed bytes.
 */
export function deriveCanonicalMcpToolListing(modules: McpToolFixtureModules): string {
  const meta = mcpToolFixtureMetaSchema.parse(modules.meta);
  const envelope = toolsListEnvelopeSchema.parse(modules.raw);
  const { canonicalFileSha256: _sha, files, ...provenance } = meta;
  return `${JSON.stringify(
    {
      meta: {
        ...provenance,
        derivedFrom: files.raw,
        derivation:
          "result.tools verbatim, listing order preserved; only whitespace differs from the raw file",
      },
      jsonrpc: envelope.jsonrpc,
      id: envelope.id,
      result: envelope.result,
    },
    null,
    2
  )}\n`;
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
