// SPDX-License-Identifier: Apache-2.0
/**
 * F-1172 / F-1176 guard: every field the twin declares on a Linear type must be
 * a field Linear actually declares — on the output types AND on the four
 * agent-session mutation inputs.
 *
 * This is a SUBSET check, not an equality check. The twin models a slice of
 * Linear on purpose — missing fields are ordinary coverage scope. Inventing a
 * field name (or an enum member) Linear does not have is a fidelity defect: an
 * agent written against real Linear reads `undefined` from the twin, and an
 * agent written against the twin breaks in production.
 *
 * Upstream truth is `fixtures/linear-introspection.json`, a committed slice of
 * Linear's real introspection response. Refresh it with
 * `node scripts/regen-linear-introspection.mjs`.
 *
 * A type ABSENT from the fixture is UNGUARDED, so this file also asserts that
 * the types we expect to be guarded are actually present — otherwise an empty
 * or truncated fixture would make the whole check pass vacuously.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  buildSchema,
  printSchema,
  type GraphQLNamedType,
  type GraphQLSchema,
} from "graphql";
import { describe, expect, it } from "vitest";
import { AGENT_SESSION_STATUSES } from "../src/domain/normalize.js";
import { linearGraphQLSchema } from "../src/graphql/schema.js";

type UpstreamType = {
  kind: string;
  fields?: Record<string, string>;
  inputFields?: Record<string, string>;
  enumValues?: string[];
};

type UpstreamSlice = {
  source: string;
  fetched_at: string;
  guarded_types: string[];
  types: Record<string, UpstreamType>;
};

const upstream = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "linear-introspection.json"), "utf8")
) as UpstreamSlice;

/**
 * Types the guard must actually be checking. Kept here, not read off the
 * fixture, so that deleting a type from the fixture fails loudly instead of
 * silently removing coverage.
 *
 * SCOPE — both directions of the agent-session surface. The four mutation INPUT
 * types are here too (F-1176), so this file is evidence about the input surface
 * as well as the output one. Keep it in step with `GUARDED_TYPES` in
 * `scripts/regen-linear-introspection.mjs`.
 */
const MUST_BE_GUARDED = [
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

/** Member names the twin declares for a named type, or null if it declares no such type. */
function twinMembers(name: string, schema: GraphQLSchema = linearGraphQLSchema): {
  kind: string;
  members: string[];
} | null {
  const type: GraphQLNamedType | undefined = schema.getType(name) ?? undefined;
  if (!type) return null;
  if (type instanceof GraphQLObjectType) return { kind: "OBJECT", members: Object.keys(type.getFields()) };
  if (type instanceof GraphQLInputObjectType) {
    return { kind: "INPUT_OBJECT", members: Object.keys(type.getFields()) };
  }
  if (type instanceof GraphQLEnumType) {
    return { kind: "ENUM", members: type.getValues().map((value) => value.name) };
  }
  return { kind: "OTHER", members: [] };
}

/** Member names Linear declares for a fixture entry. */
function upstreamMembers(entry: UpstreamType): string[] {
  return Object.keys(entry.fields ?? entry.inputFields ?? {}).concat(entry.enumValues ?? []);
}

/** The members a schema declares on `name` that Linear does not. This IS the guard. */
function inventedMembers(name: string, schema: GraphQLSchema = linearGraphQLSchema): string[] {
  const entry = upstream.types[name];
  if (!entry) throw new Error(`${name} is absent from linear-introspection.json, so it is unguarded`);
  const declared = new Set(upstreamMembers(entry));
  return (twinMembers(name, schema)?.members ?? []).filter((member) => !declared.has(member)).sort();
}

/**
 * The twin's own SDL with one extra field spliced onto a type, rebuilt through
 * `buildSchema` exactly as `src/graphql/schema.ts` does. Used to prove the guard
 * can fail — see the test at the bottom of this file.
 */
function schemaWithInventedMember(typeName: string, declaration: string): GraphQLSchema {
  const sdl = printSchema(linearGraphQLSchema);
  const opener = new RegExp(`^(input|type|enum) ${typeName} \\{$`, "m");
  if (!opener.test(sdl)) throw new Error(`${typeName} is not declared in the twin's SDL`);
  return buildSchema(sdl.replace(opener, (header) => `${header}\n  ${declaration}`));
}

describe("twin GraphQL types stay a subset of Linear's real schema (F-1172, F-1176)", () => {
  it("guards the types it claims to guard", () => {
    expect(upstream.source).toBe("https://api.linear.app/graphql");
    for (const name of MUST_BE_GUARDED) {
      const entry = upstream.types[name];
      expect(entry, `${name} missing from linear-introspection.json — the guard would pass vacuously`)
        .toBeDefined();
      expect(
        upstreamMembers(entry as UpstreamType).length,
        `${name} has no members in linear-introspection.json`
      ).toBeGreaterThan(0);
    }
  });

  for (const name of MUST_BE_GUARDED) {
    it(`${name} declares no field Linear does not have`, () => {
      const entry = upstream.types[name];
      expect(entry).toBeDefined();
      const twin = twinMembers(name);
      // The twin is allowed not to model a type at all; it is not allowed to
      // model one under names Linear does not use.
      if (!twin) return;
      expect(twin.kind).toBe((entry as UpstreamType).kind);
      const invented = inventedMembers(name);
      expect(invented, `${name} declares members Linear does not: ${invented.join(", ")}`).toEqual([]);
    });
  }

  it("the status values the domain accepts are the ones the SDL declares", () => {
    // Two declarations of the same enum (SDL + the TS union the writers validate
    // against) can drift apart; a value the domain accepts but the SDL rejects
    // would blow up at serialisation time, not at authoring time.
    expect(AGENT_SESSION_STATUSES.slice().sort()).toEqual(twinMembers("AgentSessionStatus")?.members.sort());
  });

  /**
   * A guard that cannot fail is not a guard. `MUST_BE_GUARDED` proves the
   * fixture has upstream truth to compare against; these prove the comparison
   * itself bites. Each case splices an invented member into the twin's own SDL,
   * rebuilds it the way `src/graphql/schema.ts` does, and asserts the guard
   * names exactly that member — so this fails if the check is ever softened
   * into a no-op.
   */
  it.each([
    ["AgentSessionUpdateInput", "status: AgentSessionStatus", "status"],
    ["AgentSessionCreateOnIssue", "appUserId: String", "appUserId"],
    ["AgentSessionCreateOnComment", "appUserId: String", "appUserId"],
    ["AgentActivityCreateInput", "sessionId: String", "sessionId"],
    ["AgentActivity", "body: String", "body"],
    ["AgentSession", "externalUrl: String", "externalUrl"],
  ])("the guard catches an invented %s.%s", (typeName, declaration, member) => {
    expect(inventedMembers(typeName)).toEqual([]);
    expect(inventedMembers(typeName, schemaWithInventedMember(typeName, declaration))).toEqual([member]);
  });

  it("an invented enum member is caught too", () => {
    expect(
      twinMembers("AgentActivitySignal", buildSchema("enum AgentActivitySignal { stop cancel }"))?.members
    ).toEqual(["stop", "cancel"]);
    expect(
      inventedMembers("AgentActivitySignal", buildSchema("enum AgentActivitySignal { stop cancel }"))
    ).toEqual(["cancel"]);
  });

  it("AgentSession carries the fields the twin promises to model", () => {
    const twin = twinMembers("AgentSession");
    expect(twin?.members.slice().sort()).toEqual(
      ["activities", "appUser", "comment", "createdAt", "externalUrls", "id", "issue", "plan", "status", "updatedAt"]
    );
  });
});
