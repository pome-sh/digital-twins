// SPDX-License-Identifier: Apache-2.0
/**
 * Refresh `fixtures/linear-introspection.json` — the committed slice of Linear's
 * real GraphQL introspection that `test/linear-schema-subset.test.ts` checks the
 * twin's SDL against (F-1172).
 *
 * WHY A SLICE. Linear's full introspection response is ~1.5 MB and 1,100+ types.
 * The guard only needs the types the twin claims to emulate, so this vendors
 * exactly those. A type that is ABSENT from the fixture is UNGUARDED — the guard
 * cannot check what upstream truth it was never given. Add a name to
 * `GUARDED_TYPES` to bring a type under the guard.
 *
 * NO CREDENTIALS. Linear answers introspection unauthenticated, which is what
 * lets this stay a normal, offline-refreshable fixture:
 *
 *   curl -s -X POST https://api.linear.app/graphql -H 'Content-Type: application/json' \
 *     -d '{"query":"{__schema{queryType{name}}}"}'
 *
 * Usage:
 *   node scripts/regen-linear-introspection.mjs
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * The upstream types the twin models and must not drift from. Extend this list
 * (and re-run) when the twin starts emulating another Linear type.
 *
 * SCOPE. Both sides of the agent-session surface are guarded: the output types
 * and enums the twin emits, and the four mutation input objects it accepts
 * (F-1176). The guard is name-based — a member the twin declares must be a
 * member Linear declares. It does not compare SDL types; two scalar-level
 * divergences are open and written up in `REFERENCE-DIVERGENCES.md`.
 *
 * Deprecated upstream fields count as declared. `AgentSession.externalUrls`,
 * `externalLink`, `externalLinks`, `type` and `workspaceDiffFiles` are all
 * deprecated but real, and appear only under `includeDeprecated: true` — which
 * is why the query below passes it. Dropping that flag would make the fixture
 * claim Linear removed fields it still serves.
 */
const GUARDED_TYPES = [
  "AgentSession",
  "AgentSessionStatus",
  "AgentSessionExternalUrlInput",
  "AgentActivity",
  "AgentActivitySignal",
  "AgentSessionCreateOnIssue",
  "AgentSessionCreateOnComment",
  "AgentSessionUpdateInput",
  "AgentActivityCreateInput",
];

const QUERY = `query PomeTwinLinearIntrospection($name: String!) {
  __type(name: $name) {
    kind
    name
    fields(includeDeprecated: true) { name type { ...TypeRef } }
    inputFields { name type { ...TypeRef } }
    enumValues(includeDeprecated: true) { name }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

/** Render an introspected type reference as SDL (`String!`, `[Issue!]!`). */
function sdl(ref) {
  if (!ref) return "?";
  if (ref.kind === "NON_NULL") return `${sdl(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${sdl(ref.ofType)}]`;
  return ref.name ?? "?";
}

function byName(entries) {
  return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

async function introspect(name) {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { name } }),
  });
  if (!response.ok) throw new Error(`Linear introspection failed for ${name}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors) throw new Error(`Linear introspection errored for ${name}: ${JSON.stringify(body.errors)}`);
  const type = body.data?.__type;
  if (!type) throw new Error(`Linear does not declare a type named ${name}`);
  return type;
}

const types = {};
for (const name of GUARDED_TYPES) {
  const type = await introspect(name);
  const entry = { kind: type.kind };
  if (type.fields) entry.fields = byName(type.fields.map((f) => [f.name, sdl(f.type)]));
  if (type.inputFields) entry.inputFields = byName(type.inputFields.map((f) => [f.name, sdl(f.type)]));
  if (type.enumValues) entry.enumValues = type.enumValues.map((v) => v.name).sort();
  types[name] = entry;
}

const artifact = {
  _readme:
    "Committed slice of Linear's real GraphQL introspection. A type absent here is UNGUARDED. " +
    "Regenerate with `node scripts/regen-linear-introspection.mjs`; never hand-edit.",
  source: LINEAR_GRAPHQL_URL,
  fetched_at: new Date().toISOString(),
  query_sha256: createHash("sha256").update(QUERY).digest("hex"),
  guarded_types: GUARDED_TYPES.slice().sort(),
  types: byName(Object.entries(types)),
};

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "linear-introspection.json");
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`wrote ${out} (${GUARDED_TYPES.length} types)`);
