// SPDX-License-Identifier: Apache-2.0
/**
 * F-1172 guard: every field the twin declares on a Linear type must be a field
 * Linear actually declares.
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
  type GraphQLNamedType,
} from "graphql";
import { describe, expect, it } from "vitest";
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
 */
const MUST_BE_GUARDED = ["AgentSession", "AgentSessionStatus", "AgentSessionExternalUrlInput"];

/** Member names the twin declares for a named type, or null if it declares no such type. */
function twinMembers(name: string): { kind: string; members: string[] } | null {
  const type: GraphQLNamedType | undefined = linearGraphQLSchema.getType(name) ?? undefined;
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

describe("twin GraphQL types stay a subset of Linear's real schema (F-1172)", () => {
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
      const declared = new Set(upstreamMembers(entry as UpstreamType));
      const invented = twin.members.filter((member) => !declared.has(member)).sort();
      expect(invented, `${name} declares members Linear does not: ${invented.join(", ")}`).toEqual([]);
    });
  }

  it("AgentSession carries the fields the twin promises to model", () => {
    const twin = twinMembers("AgentSession");
    expect(twin?.members.slice().sort()).toEqual(
      ["activities", "appUser", "comment", "createdAt", "externalUrls", "id", "issue", "plan", "status", "updatedAt"]
    );
  });
});
