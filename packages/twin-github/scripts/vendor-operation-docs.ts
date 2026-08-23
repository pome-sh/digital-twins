// SPDX-License-Identifier: Apache-2.0
//
// Vendor GitHub's per-operation `documentation_url` as a committed
// artifact, the way `fixtures/mcp-tools-list.raw.json` vendors its tool table.
//
//   npx tsx scripts/vendor-operation-docs.ts --fetch     # write, downloading the spec
//   npx tsx scripts/vendor-operation-docs.ts --spec <p>  # write, from a local copy
//   npx tsx scripts/vendor-operation-docs.ts --check      # verify only (what CI runs)
//
// ── WHY A SLICE AND NOT THE SPEC ────────────────────────────────────────────
//
// `descriptions/api.github.com/api.github.com.json` is 12.9 MB of OpenAPI over
// 808 paths. Committing it would put a vendor dump in every clone and every npm
// tarball to serve ~70 urls. So the producer derives the slice this twin's doors
// actually need — operation id → `externalDocs.url`, plus the
// `x-github.category` / `subcategory` pair that reproduces the anchor, plus the
// vendor's own method and path so the pairing can be re-checked offline — and
// commits that. The full description stays a pinned COMMIT plus a pinned
// SHA-256 below, so re-deriving it is one command and adopting different bytes
// is a deliberate two-constant edit rather than a silent drift.
//
// ── WHAT `--check` PROVES WITHOUT THE SPEC ──────────────────────────────────
//
// CI has no 12.9 MB file and no network budget for one, so `--check` re-derives
// everything that does not need the vendor bytes and compares it: the artifact's
// REST keys must be exactly the surfaces the twin MOUNTS, its MCP keys exactly
// the tools it SERVES, every pairing must be the one `operation-docs-artifact.ts`
// decides, every mapped `method` must be one the tool's zod schema accepts,
// every operation must be referenced by some door, and every url must be
// `https://docs.github.com/rest/<category>/<subcategory>#<anchor>` — the two
// committed columns checking each other. `rawFileSha256` catches a hand edit to
// the file; the pinned commit in `meta.source` must still be this script's.
//
// Hand `--check` a spec (`--spec <path>`, or `POME_GITHUB_OPENAPI`) and it also
// re-derives every url from the vendor and byte-diffs both files.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_ROUTE_INPUTS } from "../src/route-inputs.js";
import { githubToolInputSchema, toolArgumentSchemas } from "../src/tools.js";
import type { OperationDocsArtifact } from "../src/operation-docs.js";
import {
  MCP_OPERATIONS,
  RESOLVED_BY_HAND,
  TWIN_ONLY_ROUTES,
  UNMAPPABLE_TOOLS,
  deriveOperationDocs,
  verifyOperationDocs,
  type OpenApiDescription,
} from "./operation-docs-artifact.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const RAW = "operation-docs.raw.json";
const META = "operation-docs.meta.json";

/**
 * The vendor bytes this artifact was derived from. Pinned by COMMIT, not by
 * `main`: `main` is a moving target that would make two runs a week apart
 * disagree with no edit in between, and `rawFileSha256` alone cannot tell a
 * vendor change from a hand edit.
 *
 * Adopting a newer description is deliberate — move both constants, re-run the
 * write mode, and read the diff. A spec whose bytes are not `SOURCE_SHA256` is
 * REFUSED rather than silently adopted.
 */
const SOURCE_REPO = "github/rest-api-description";
const SOURCE_PATH = "descriptions/api.github.com/api.github.com.json";
const SOURCE_COMMIT = "dd9838813134ed73e8ab5f6691cea774a7c04639";
const SOURCE_SHA256 = "80850db290cde4eb487e0efb587cf27f305e77b6bef96933ed8a09b5169d5b1d";
const SOURCE_URL = `https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_COMMIT}/${SOURCE_PATH}`;
/** The day these bytes were vendored. A constant so the write mode is a pure function. */
const VENDORED_ON = "2026-08-13";
const PRODUCER =
  "packages/twin-github/scripts/vendor-operation-docs.ts — re-derive and diff with " +
  "`npm run gate:operation-docs -w @pome-sh/twin-github`";

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const fetchSpec = argv.includes("--fetch");
const specFlag = argv.indexOf("--spec");
const specPath = specFlag >= 0 ? argv[specFlag + 1] : process.env.POME_GITHUB_OPENAPI;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const surfaces = GITHUB_ROUTE_INPUTS.map((declaration) => declaration.surface);
/** Tool name → the `method` values its validator accepts (undefined for the 32 that take none). */
const toolMethods: Record<string, readonly string[] | undefined> = Object.fromEntries(
  toolArgumentSchemas.map((tool) => {
    const properties = (githubToolInputSchema(tool.schema as never).properties ?? {}) as Record<
      string,
      { enum?: unknown }
    >;
    const values = properties.method?.enum;
    return [tool.name, Array.isArray(values) ? (values as string[]) : undefined];
  })
);

async function loadSpec(): Promise<{ text: string; spec: OpenApiDescription } | undefined> {
  let text: string | undefined;
  if (specPath) text = readFileSync(specPath, "utf8");
  else if (fetchSpec) {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`GET ${SOURCE_URL} answered ${response.status}`);
    text = await response.text();
  }
  if (text === undefined) return undefined;
  const digest = sha256(text);
  if (digest !== SOURCE_SHA256) {
    throw new Error(
      `the description supplied hashes to ${digest}, and this script is pinned to ${SOURCE_SHA256} ` +
        `(${SOURCE_REPO}@${SOURCE_COMMIT}). Adopting different vendor bytes is deliberate: move ` +
        `SOURCE_COMMIT and SOURCE_SHA256 together, re-run the write mode, and read the diff.`
    );
  }
  return { text, spec: JSON.parse(text) as OpenApiDescription };
}

function buildMeta(input: {
  artifact: OperationDocsArtifact;
  rawText: string;
  spec: OpenApiDescription;
  resolvedByShape: number;
}) {
  const twinOnly = Object.keys(input.artifact.rest).filter((s) => input.artifact.rest[s] === null);
  const unmappable = Object.keys(input.artifact.mcp).filter((t) => input.artifact.mcp[t] === null);
  return {
    substrate: "vendor-openapi-projection",
    source: {
      repo: SOURCE_REPO,
      path: SOURCE_PATH,
      commit: SOURCE_COMMIT,
      url: SOURCE_URL,
      openapi: input.spec.openapi,
      specVersion: input.spec.info?.version,
      specPathCount: Object.keys(input.spec.paths).length,
      specFileSha256: SOURCE_SHA256,
    },
    captureDate: VENDORED_ON,
    producer: PRODUCER,
    rawFileSha256: sha256(input.rawText),
    operationCount: Object.keys(input.artifact.operations).length,
    restSurfaceCount: Object.keys(input.artifact.rest).length,
    mcpToolCount: Object.keys(input.artifact.mcp).length,
    resolution: {
      restResolvedByPathShape: input.resolvedByShape,
      restResolvedByHand: Object.fromEntries(
        Object.entries(RESOLVED_BY_HAND).map(([surface, entry]) => [
          surface,
          `${entry.operationId} — ${entry.reason}`,
        ])
      ),
      restTwinOnly: Object.fromEntries(twinOnly.map((surface) => [surface, TWIN_ONLY_ROUTES[surface]!])),
      mcpDecided: Object.keys(MCP_OPERATIONS).length,
      mcpUnmappable: Object.fromEntries(unmappable.map((tool) => [tool, UNMAPPABLE_TOOLS[tool]!])),
    },
    /**
     * ⚠️ The generic classes, restated on the file so a reader of the artifact
     * alone cannot mistake them for gaps. GitHub itself answers
     * `https://docs.github.com/rest` on 14 of 59 measured errors: every 401
     * (auth fails before dispatch), every unrouted path, and `GET /users/{u}` —
     * a one-off this twin does not serve. Naming an operation there would be a
     * NEW divergence in the opposite direction.
     */
    genericByMeasurement: [
      "every 401 — authentication fails before dispatch, so there is no operation to name (8/8 measured)",
      "every unrouted path — the 501 catch-all names nothing (4/4 measured)",
      "GET /users/{username} — a genuine GitHub one-off this twin serves no route for (2/2 measured)",
    ],
  };
}

const loaded = await loadSpec();

if (!check) {
  if (!loaded) {
    throw new Error(
      `the write mode needs the vendor description: pass --fetch to download ${SOURCE_URL}, or ` +
        `--spec <path> / POME_GITHUB_OPENAPI for a local copy.`
    );
  }
  const { artifact, resolvedByShape } = deriveOperationDocs({
    spec: loaded.spec,
    surfaces,
    tools: toolArgumentSchemas.map((tool) => tool.name),
  });
  const problems = verifyOperationDocs({ artifact, surfaces, toolMethods });
  if (problems.length > 0) {
    console.error(`[vendor-operation-docs] refusing to write:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const rawText = `${JSON.stringify(artifact, null, 2)}\n`;
  const metaText = `${JSON.stringify(buildMeta({ artifact, rawText, spec: loaded.spec, resolvedByShape }), null, 2)}\n`;
  writeFileSync(join(FIXTURES, RAW), rawText);
  writeFileSync(join(FIXTURES, META), metaText);
  console.log(
    `[vendor-operation-docs] wrote ${Object.keys(artifact.operations).length} operations for ` +
      `${surfaces.length} REST surfaces (${resolvedByShape} by path shape, ` +
      `${Object.keys(RESOLVED_BY_HAND).length} by hand, ${Object.keys(TWIN_ONLY_ROUTES).length} ` +
      `twin-only) and ${Object.keys(toolMethods).length} MCP tools ` +
      `(${Object.keys(UNMAPPABLE_TOOLS).length} unmappable)`
  );
} else {
  const rawText = read(RAW);
  const artifact = JSON.parse(rawText) as OperationDocsArtifact;
  const meta = JSON.parse(read(META)) as Record<string, unknown>;
  const problems = verifyOperationDocs({ artifact, surfaces, toolMethods });

  const digest = sha256(rawText);
  if (digest !== meta.rawFileSha256) {
    problems.push(
      `${RAW} hashes to ${digest} and ${META} declares ${String(meta.rawFileSha256)} — the file was ` +
        `edited by hand since it was derived.`
    );
  }
  const source = (meta.source ?? {}) as Record<string, unknown>;
  if (source.commit !== SOURCE_COMMIT || source.specFileSha256 !== SOURCE_SHA256) {
    problems.push(
      `${META} was derived from ${SOURCE_REPO}@${String(source.commit)} and this script is pinned to ` +
        `${SOURCE_COMMIT}. Re-run the write mode against the pinned description.`
    );
  }

  if (loaded) {
    const { artifact: derived, resolvedByShape } = deriveOperationDocs({
      spec: loaded.spec,
      surfaces,
      tools: toolArgumentSchemas.map((tool) => tool.name),
    });
    const derivedRaw = `${JSON.stringify(derived, null, 2)}\n`;
    const derivedMeta = `${JSON.stringify(buildMeta({ artifact: derived, rawText: derivedRaw, spec: loaded.spec, resolvedByShape }), null, 2)}\n`;
    if (derivedRaw !== rawText) problems.push(`${RAW} differs from what the vendor description derives.`);
    if (derivedMeta !== read(META)) problems.push(`${META} differs from what the vendor description derives.`);
  }

  if (problems.length > 0) {
    console.error(`[vendor-operation-docs] ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `[vendor-operation-docs] ${Object.keys(artifact.operations).length} operations, ` +
      `${surfaces.length} REST surfaces, ${Object.keys(toolMethods).length} MCP tools — ` +
      (loaded ? "byte-identical to the pinned description" : "consistent (no description supplied)")
  );
}
