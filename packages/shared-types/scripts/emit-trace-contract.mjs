#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Emits trace-contract.json — the machine-readable descriptor that ships inside
// the published package. Default mode writes the file; `--check` fails when the
// committed file is missing or stale, AND (F-1201) when a member of the event
// union has no fixture.
//
// WHY THE EVENT-KIND HALF EXISTS — F-1201.
//
// Until F-1201 this script built the contract from three parts, none of which
// ever read the schema: a hardcoded four-string `canonicalSchemas` literal, a
// directory walk of `test/fixtures/v1/**.json`, and five subpath strings.
// Adding a member to `eventSchema` therefore changed the emitted JSON *not at
// all*, so `--check` (a byte compare) was green BY CONSTRUCTION. There was no
// code path in which a new kind could turn it red — and the corpus proved it:
// all 18 fixtures were session/run/plan shapes and the contract carried zero
// event-kind entries. That is how M1 shipped `LlmTurnEvent` with nothing on the
// wire-fixture side describing it.
//
// The rule now: every member of the event union needs at least one fixture
// under `test/fixtures/v1/event/<Kind>/`, and the kind list is ENUMERATED FROM
// THE ZOD UNION at emit time rather than typed out here. A new kind with no
// fixture fails both `emit:trace-contract` and `check:trace-contract` — you
// cannot regenerate your way past it, which is the whole point: a gate you can
// silence by re-running the generator is the gate this one replaces.
//
// `unionKinds` walks `otelEventSchema`, not `eventSchema`, so the OTel arm
// (`OtelSpanEvent`) is covered on the same terms as the seven legacy kinds.
// It THROWS on a schema node it does not understand rather than returning a
// short list — a silently-empty kind list would restore exactly the vacuous
// gate this replaces.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The schema lives in TypeScript and node >= 23.6 strips types natively, but
// `src/otel/**` imports its siblings with the `.js` extensions TypeScript
// requires under NodeNext — and those `.js` files do not exist on disk. Rewrite
// a relative `.js` specifier to the `.ts` beside it so the OTel tree loads
// without a build step. (`src/manifest.ts` needs none of this, which is why
// `emit-manifest-schema.mjs` imports it directly.)
//
// The rewrite is unconditional when the `.ts` exists, so `npm run build:runtime`
// — which emits `.js` IN PLACE beside each `.ts` for the Docker/contract boots —
// cannot shadow the source this contract is generated from.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

// The schemas this package declares canonical. Still a curated list — it names
// WHICH schemas are the contract, a question no introspection can answer — but
// no longer an unchecked one: `assertCanonicalSchemas` proves each is really on
// the barrel, so a rename cannot leave a dangling name here.
export const CANONICAL_SCHEMAS = [
  "recorderEventSchema",
  "eventSchema",
  "otelEventSchema",
  "runSchema",
];

const FIXTURE_HINT = "test/fixtures/v1/event/<Kind>/<name>.json";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (entry.name.endsWith(".json")) out.push(abs);
  }
  return out;
}

const toPosix = (p) => p.replaceAll("\\", "/");

/**
 * Enumerate the `kind` discriminator of every member of an event union, in
 * declaration order.
 *
 * Handles the three node types the union is actually built from: `.transform()`
 * wraps the union in a pipe, `z.union` / `z.discriminatedUnion` hold members in
 * `def.options`, and each member is a plain object whose `kind` is a literal.
 * `.superRefine()` does not wrap in zod 4 (it appends a check), so
 * `otelSpanEventSchema` arrives here as an object like any other.
 *
 * Anything else throws. Returning a partial list on an unrecognized node is the
 * failure mode F-1201 exists to remove.
 */
export function unionKinds(schema, path = "otelEventSchema") {
  const kinds = collectKinds(schema, path, []);
  const seen = new Set();
  for (const kind of kinds) {
    if (seen.has(kind)) {
      throw new Error(`${path}: two union members share the kind "${kind}".`);
    }
    seen.add(kind);
  }
  return kinds;
}

function collectKinds(schema, path, out) {
  const def = schema?.def;
  if (!def) throw new Error(`${path} is not a zod schema.`);

  if (def.type === "pipe") return collectKinds(def.in, `${path}.in`, out);

  if (def.type === "union") {
    def.options.forEach((option, i) => collectKinds(option, `${path}[${i}]`, out));
    return out;
  }

  if (def.type === "object") {
    const discriminator = def.shape.kind;
    if (discriminator?.def?.type !== "literal") {
      throw new Error(`${path} has no literal "kind" discriminator.`);
    }
    out.push(...discriminator.def.values);
    return out;
  }

  throw new Error(
    `${path}: unhandled zod node "${def.type}". Teach unionKinds about it — a kind ` +
      "it cannot see is a kind this gate cannot require a fixture for.",
  );
}

/** Every name in `names` must be a real export of the barrel. */
export function assertCanonicalSchemas(api, names) {
  const missing = names.filter((name) => api[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `trace-contract.json names schema(s) that the barrel no longer exports: ${missing.join(", ")}.\n` +
        "Update CANONICAL_SCHEMAS in scripts/emit-trace-contract.mjs, or restore the export.",
    );
  }
}

/**
 * Read the event-fixture corpus. Each record carries the path recorded in the
 * contract, the directory that claims its kind, and the parsed row.
 */
export function collectEventFixtures(eventRoot, rootForPaths) {
  if (!existsSync(eventRoot)) return [];
  return walk(eventRoot)
    .map((abs) => {
      const path = toPosix(relative(rootForPaths, abs));
      const source = readFileSync(abs, "utf8");
      try {
        return { path, dir: basename(dirname(abs)), row: JSON.parse(source) };
      } catch (error) {
        // A bare SyntaxError names a byte offset and no file.
        throw new Error(`${path} is not valid JSON: ${error.message}`);
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Map each union member to its fixtures, in union declaration order. Throws
 * when a kind has none, when a fixture claims a kind the union does not have
 * (a rename), or when a fixture sits in the wrong directory.
 */
export function auditEventFixtures(kinds, fixtures) {
  const byKind = new Map(kinds.map((kind) => [kind, []]));
  const problems = [];

  for (const fixture of fixtures) {
    const row = fixture.row;
    const kind = row !== null && typeof row === "object" && !Array.isArray(row) ? row.kind : undefined;

    if (typeof kind !== "string") {
      problems.push(`${fixture.path} has no string "kind" — every event fixture is a single tagged row.`);
      continue;
    }
    if (kind !== fixture.dir) {
      problems.push(
        `${fixture.path} declares kind "${kind}" but sits under "${fixture.dir}/". ` +
          "A fixture's directory is its kind.",
      );
      continue;
    }
    if (!byKind.has(kind)) {
      problems.push(
        `${fixture.path} declares kind "${kind}", which is not a member of the event union ` +
          `(members: ${kinds.join(", ")}). Renamed the kind? Rename its fixture directory too.`,
      );
      continue;
    }
    byKind.get(kind).push(fixture.path);
  }

  const missing = [...byKind].filter(([, paths]) => paths.length === 0).map(([kind]) => kind);
  if (missing.length > 0) {
    problems.push(
      `no fixture for event kind(s): ${missing.join(", ")}.\n` +
        `  Every member of the event union needs at least one fixture at ${FIXTURE_HINT},\n` +
        "  holding a row whose \"kind\" is that member. See test/fixtures/v1/README.md.\n" +
        `  Missing: ${missing.map((kind) => `test/fixtures/v1/event/${kind}/`).join(", ")}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `trace-contract.json event-fixture coverage failed (F-1201):\n- ${problems.join("\n- ")}`,
    );
  }

  return Object.fromEntries(byKind);
}

export function buildContract({ pkg, eventKinds, fixtures }) {
  return {
    package: pkg.name,
    version: pkg.version,
    zod: {
      range: pkg.peerDependencies.zod,
      major: 4,
    },
    exports: {
      root: "@pome-sh/shared-types",
      recorderEvents: "@pome-sh/shared-types/recorder-events",
      run: "@pome-sh/shared-types/run",
      otel: "@pome-sh/shared-types/otel",
      redaction: "@pome-sh/shared-types/redaction",
    },
    canonicalSchemas: [...CANONICAL_SCHEMAS],
    // Union declaration order, not sorted: the contract mirrors the schema.
    eventKinds,
    fixtures,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const rootIdx = args.indexOf("--root");
  const outIdx = args.indexOf("--out");
  // `--root` retargets the package tree the contract is built FROM (package.json,
  // fixtures, default output). The schema always comes from this checkout — the
  // union is never a fixture. Used by emit-trace-contract.test.mjs to prove the
  // corpus gate against a throwaway tree.
  const packageRoot = resolve(rootIdx >= 0 ? args[rootIdx + 1] : scriptRoot);
  const outPath = resolve(outIdx >= 0 ? args[outIdx + 1] : join(packageRoot, "trace-contract.json"));

  const api = await import("../src/index.ts");
  assertCanonicalSchemas(api, CANONICAL_SCHEMAS);

  const kinds = unionKinds(api.otelEventSchema);
  const fixturesRoot = join(packageRoot, "test/fixtures/v1");
  const eventKinds = auditEventFixtures(
    kinds,
    collectEventFixtures(join(fixturesRoot, "event"), packageRoot),
  );

  const contract = buildContract({
    pkg: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
    eventKinds,
    fixtures: walk(fixturesRoot)
      .map((file) => toPosix(relative(packageRoot, file)))
      .sort(),
  });

  const body = `${JSON.stringify(contract, null, 2)}\n`;

  if (check) {
    if (!existsSync(outPath)) {
      throw new Error(`${relative(packageRoot, outPath)} does not exist. Run emit:trace-contract.`);
    }
    if (readFileSync(outPath, "utf8") !== body) {
      throw new Error(`${relative(packageRoot, outPath)} is stale. Run emit:trace-contract.`);
    }
  } else {
    writeFileSync(outPath, body);
  }

  console.log(relative(packageRoot, outPath));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
