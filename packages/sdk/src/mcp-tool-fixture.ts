// file-size: one fixture contract — the substrate vocabulary, the provenance
// schema that enforces it, and the loader that turns a validated fixture into a
// tool table. Splitting it would put the vocabulary in one file and the rules
// that give each value its cost in another, which is the fork this module's own
// `substrate-vocabulary.test.ts` exists because of: `substrate` is already
// validated in three places across two repos, and only two of them are
// import-checked against each other.
// SPDX-License-Identifier: Apache-2.0
//
// Every twin derives its MCP tool table from a fixture.
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
 * How the bytes in a fixture came to be. ONE vocabulary, shared with F-1326's
 * upstream capture producer (`scripts/capture-mcp-tools-list.mjs`).
 *
 * The first four values are that producer's registry, verbatim and complete —
 * including `not-captured`, which the producer uses for a twin whose upstream
 * cannot be faithfully read. F-1327 has to read both trees, so this enum is
 * required to be a SUPERSET of the producer's: `substrate-vocabulary.test.ts`
 * imports the producer and asserts it, because two validators of the same
 * field name in two languages with no import between them is exactly how a
 * vocabulary silently forks.
 *
 * The last three are additions this side needs, and the producer has no use for.
 * The first two describe a table nobody read from upstream at all, and exist so
 * that fact has to be stated instead of implied:
 *
 * - `twin-code-transcription` — the fixture is a transcription of the listing
 *   the twin's own code already served. It says nothing about the vendor.
 * - `twin-authored-from-vendor-docs` — the tool NAMES come from the vendor's
 *   published documentation; the schemas are the twin's own.
 *
 * A twin on either of those has never been compared to its upstream.
 * `transcription.comparedToUpstream` has to say so.
 *
 * - `upstream-capture-projection` — MOST of the rows are an upstream capture's,
 *   copied through byte for byte, and the exceptions are named. It is not a
 *   producer value because no capture produces it, and it is not twin-owned
 *   because its content was read from the vendor; it is the honest word for a
 *   fixture that is a capture's bytes plus a declared, reasoned residue.
 *
 *   twin-slack and twin-gmail do NOT need it: their producers can only SUBTRACT,
 *   so every surviving row is the capture's and the capture's own substrate
 *   (`live-wire-oauth` / `live-wire-unauth`) stays exactly true. twin-github
 *   cannot reach that shape. Two of the tools it serves — `create_issue` and
 *   `create_pull_request_review` — are ones GitHub registers behind feature
 *   flags (`issues_granular`, `pull_requests_granular`), and the golden is
 *   captured with no flags set ON PURPOSE, because that is the surface an
 *   examinee pointed at `api.githubcopilot.com/mcp/` actually gets. So those two
 *   rows can never come from the capture, and claiming `oss-source` over the
 *   whole file would be an overclaim on exactly the two rows a reader most needs
 *   to know about. `projection.carried` names them, with a reason each.
 *
 * The same value can legitimately differ between the two trees for one twin,
 * because they describe different subjects: `fixtures/mcp-tools-list/github.*`
 * is `oss-source` (what GitHub serves) while
 * `packages/twin-github/fixtures/mcp-tools-list.*` is
 * `upstream-capture-projection` (what the twin serves, and where those rows came
 * from). That is not drift. Which subject a file describes is fixed by where it
 * lives — which is also why the projection has to name its source by DIGEST
 * rather than by path: two files in two directories describing the same vendor
 * is the arrangement in which "these are the same bytes" stops being obvious.
 */
export const mcpFixtureSubstrateSchema = z.enum([
  "live-wire-unauth",
  "live-wire-oauth",
  "oss-source",
  "not-captured",
  "twin-code-transcription",
  "twin-authored-from-vendor-docs",
  "upstream-capture-projection",
]);
export type McpFixtureSubstrate = z.infer<typeof mcpFixtureSubstrateSchema>;

/** Substrates that read a real upstream deployment: which one is not optional. */
const UPSTREAM_SUBSTRATES = new Set<McpFixtureSubstrate>([
  "live-wire-unauth",
  "live-wire-oauth",
  "oss-source",
]);

/** Substrates whose content nobody read from upstream. */
const TWIN_OWNED_SUBSTRATES = new Set<McpFixtureSubstrate>([
  "twin-code-transcription",
  "twin-authored-from-vendor-docs",
]);

/** Substrates that pin a public source tree, and must say which commit. */
const OSS_SUBSTRATES = new Set<McpFixtureSubstrate>(["oss-source"]);

/** Substrates whose rows are an upstream capture's, minus/plus a declared residue. */
const PROJECTION_SUBSTRATES = new Set<McpFixtureSubstrate>(["upstream-capture-projection"]);

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
    /**
     * The public source tree an `oss-source` capture was built from. Mandatory
     * on that substrate and rejected everywhere else: the whole reason to read
     * a vendor's OSS server rather than its wire is that the answer is
     * reproducible, and it is only reproducible from a pinned commit. Same
     * shape and same keys as F-1326's producer writes, so a golden it produced
     * parses here unchanged — which is what F-1327 does when it adopts an
     * upstream capture as a twin's fixture.
     */
    source: z
      .strictObject({
        repo: z.string().min(1),
        commit: z.string().min(1),
        package: z.string().min(1),
        language: z.string().min(1).optional(),
      })
      .optional(),
    /** Mandatory on twin-owned substrates: what this is, and what it is not. */
    transcription: z
      .strictObject({
        readFrom: z.string().min(1),
        contentOrigin: z.string().min(1),
        comparedToUpstream: z.string().min(1),
      })
      .optional(),
    /**
     * Mandatory on `upstream-capture-projection`, rejected everywhere else: WHICH
     * capture these rows came from, and every row that is not that capture's.
     *
     * The sha is the load-bearing field. `rawFileSha256` above proves this file
     * has not been hand-edited since it was derived; it says nothing about what
     * it was derived FROM, and "these are GitHub's bytes" is the whole claim a
     * projection makes. With the source digest on the file, a reader — or the
     * `--check` producer — can prove the claim instead of taking the substrate
     * word for it. Without it, re-pointing the projection at a stale or
     * hand-edited golden would re-hash clean.
     *
     * `dropped` and `carried` are records rather than lists so a name cannot be
     * added without a reason, the same rule `verification_opt_out` and the
     * MCP-lane registry are built on: the value IS the justification.
     */
    projection: z
      .strictObject({
        /** Repo-relative path of the upstream golden the rows were copied from. */
        sourceFixture: z.string().min(1),
        /** That golden's own `rawFileSha256`. Re-checked by the producer on every run. */
        sourceRawFileSha256: sha256Hex,
        sourceCaptureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)"),
        sourceSubstrate: mcpFixtureSubstrateSchema,
        /** The commit an `oss-source` golden was built from, when it pins one. */
        sourceCommit: z.string().min(1).optional(),
        /** The script that wrote this file, and the command that re-derives it. */
        producer: z.string().min(1),
        /** Tools the capture carries that this twin does not serve — name → reason. */
        dropped: z.record(z.string(), z.string().min(1)),
        /** Rows that are NOT the capture's — name → reason. Empty on a pure subtraction. */
        carried: z.record(z.string(), z.string().min(1)),
      })
      .optional(),
    notes: z.array(z.string()).optional(),
    files: z.strictObject({ raw: z.string().min(1), canonical: z.string().min(1) }),
  })
  .superRefine((meta, ctx) => {
    if (PROJECTION_SUBSTRATES.has(meta.substrate) && !meta.projection) {
      ctx.addIssue({
        code: "custom",
        path: ["projection"],
        message:
          `substrate '${meta.substrate}' claims these rows are an upstream capture's, so the fixture ` +
          `must name that capture, carry its digest, and list every row that is NOT its. A projection ` +
          `that does not say what it projected from is a substrate word doing the work of evidence.`,
      });
    }
    if (meta.projection && !PROJECTION_SUBSTRATES.has(meta.substrate)) {
      ctx.addIssue({
        code: "custom",
        path: ["projection"],
        message: `substrate '${meta.substrate}' does not project an upstream capture, so \`projection\` is a claim nothing here made.`,
      });
    }
    if (PROJECTION_SUBSTRATES.has(meta.substrate) && !meta.configuration) {
      ctx.addIssue({
        code: "custom",
        path: ["configuration"],
        message:
          `substrate '${meta.substrate}' inherits its rows from a capture, so it inherits that ` +
          `capture's configuration question too — GitHub serves 44 tools at /mcp/ and 85 at ` +
          `/mcp/x/all, and a projection that does not say which it descends from is as unarguable ` +
          `as a capture that does not.`,
      });
    }
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
    if (OSS_SUBSTRATES.has(meta.substrate) && !meta.source) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message:
          `substrate '${meta.substrate}' reads a public source tree, so the fixture must pin the ` +
          `repo, commit and package it was built from. An unpinned OSS capture is not reproducible.`,
      });
    }
    if (meta.source && !OSS_SUBSTRATES.has(meta.substrate)) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: `substrate '${meta.substrate}' does not build from source, so \`source\` is a claim nothing here made.`,
      });
    }
    // `not-captured` is the producer's value for a twin whose upstream cannot
    // be read; it belongs on a `<twin>.status.json`, which carries no listing.
    // A file that IS a tool table cannot also say nothing was captured.
    if (meta.substrate === "not-captured") {
      ctx.addIssue({
        code: "custom",
        path: ["substrate"],
        message:
          `'not-captured' records the ABSENCE of a listing — it is legal in the shared vocabulary ` +
          `and on a status file, but not on a tool table a twin serves. Use ` +
          `'twin-code-transcription' if the table was transcribed from this twin's own code.`,
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

// ── THE TYPE AXIS OF A CONFORMANCE COMPARISON ──────────────────────
//
// Each twin's `tool-schema-conformance.ts` compares its validators against the
// vendor's `inputSchema` from the fixture above. Both of the two that exist
// compared a key's PRESENCE and its requiredness, and neither compared the TYPE
// of a key both sides declare — so twin-github advertised
// `labels: {"type":"array","items":{"type":"string"}}`, validated it as
// `z.string()`, and answered `tools/call` with 422 `invalid_type` to the exact
// shape its own listing published. Both conformance reports were green
// throughout: github's pinned residue carried nothing about `labels`, and
// slack's asserts the empty list.
//
// The comparison lives here, once, rather than in each twin. Two copies of a
// check drift, and a check that drifts is the failure this whole module exists
// to end.

/**
 * A property's declared type as one comparable word, or `undefined` when it
 * cannot be stated plainly.
 *
 * `integer` folds into `number`: zod emits `integer` for `.int()` and vendors
 * spell the same argument `number`, so splitting them would report the
 * projection rather than a disagreement an examinee can hit. Unions, `anyOf`,
 * `$ref` and a missing `type` return `undefined` — silence, not a guess, for the
 * same reason.
 */
export function describeSchemaType(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object") return undefined;
  const schema = spec as { type?: unknown; items?: unknown };
  const name = (raw: unknown): string | undefined =>
    typeof raw !== "string" ? undefined : raw === "integer" ? "number" : raw;
  const type = name(schema.type);
  if (!type) return undefined;
  if (type !== "array") return type;
  const items = schema.items && typeof schema.items === "object" ? (schema.items as { type?: unknown }) : undefined;
  const element = name(items?.type);
  return element ? `array<${element}>` : "array";
}

/**
 * Every key both documents declare whose type they disagree about, phrased for
 * a conformance residue.
 *
 * PURE and exported so each twin's argument-surface test can PLANT a pair and
 * prove the comparison fires. Running it only over the real fixture cannot tell
 * a working check from one that always returns `[]` — and `[]` is what both
 * twins get today, which is the state a regression would also produce.
 *
 * @param vendor the vendor's name as the residue line should say it ("GitHub")
 */
export function typeDisagreements(
  toolName: string,
  vendor: string,
  upstreamProperties: Record<string, unknown>,
  projectedProperties: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(projectedProperties)) {
    if (!(key in upstreamProperties)) continue;
    const theirs = describeSchemaType(upstreamProperties[key]);
    const ours = describeSchemaType(projectedProperties[key]);
    if (theirs && ours && theirs !== ours) {
      problems.push(`'${toolName}' validates '${key}' as ${ours}, and ${vendor} declares it as ${theirs}`);
    }
  }
  return problems;
}
