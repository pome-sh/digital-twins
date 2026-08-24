// SPDX-License-Identifier: Apache-2.0
/** Subset guard: every field the twin declares on a Linear type must be a field Linear
 *  actually declares. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  buildSchema,
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

/** Types the guard must actually be checking. */
const MUST_BE_GUARDED = [
  "AgentActivity",
  "AgentActivityCreateInput",
  "AgentActivitySignal",
  "AgentSession",
  "AgentSessionCreateOnComment",
  "AgentSessionCreateOnIssue",
  "AgentSessionExternalUrlInput",
  "AgentSessionStatus",
  "AgentSessionUpdateInput",
];

/** Member names a schema declares for a named type, or null if it declares no such type. */
function twinMembers(schema: GraphQLSchema, name: string): { kind: string; members: string[] } | null {
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

/** The members a schema declares that Linear does not — the defect this file hunts. */
function inventedMembers(entry: UpstreamType, twin: { members: string[] }): string[] {
  const declared = new Set(upstreamMembers(entry));
  return twin.members.filter((member) => !declared.has(member)).sort();
}

describe("twin GraphQL types stay a subset of Linear's real schema", () => {
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
      const twin = twinMembers(linearGraphQLSchema, name);
      // The twin is allowed not to model a type at all; it is not allowed to
      // model one under names Linear does not use.
      if (!twin) return;
      expect(twin.kind).toBe((entry as UpstreamType).kind);
      const invented = inventedMembers(entry as UpstreamType, twin);
      expect(invented, `${name} declares members Linear does not: ${invented.join(", ")}`).toEqual([]);
    });
  }

  it("the status values the domain accepts are the ones the SDL declares", () => {
    // Two declarations of the same enum (SDL + the TS union the writers validate
    // against) can drift apart; a value the domain accepts but the SDL rejects
    // would blow up at serialisation time, not at authoring time.
    expect(AGENT_SESSION_STATUSES.slice().sort()).toEqual(
      twinMembers(linearGraphQLSchema, "AgentSessionStatus")?.members.sort()
    );
  });

  it("AgentSession carries the fields the twin promises to model", () => {
    const twin = twinMembers(linearGraphQLSchema, "AgentSession");
    expect(twin?.members.slice().sort()).toEqual(
      ["activities", "appUser", "comment", "createdAt", "externalUrls", "id", "issue", "plan", "status", "updatedAt"]
    );
  });

  it("AgentActivity carries the fields the twin promises to model", () => {
    const twin = twinMembers(linearGraphQLSchema, "AgentActivity");
    expect(twin?.members.slice().sort()).toEqual(
      ["agentSession", "content", "createdAt", "ephemeral", "id", "signal", "updatedAt", "user"]
    );
  });

  // A subset check passes on a type that declares nothing, so the four mutation inputs
  // are pinned member-for-member as well: the whole point is that an agent's.
  it("the mutation inputs carry the fields the twin promises to accept", () => {
    const declared = (name: string) => twinMembers(linearGraphQLSchema, name)?.members.slice().sort();
    expect(declared("AgentSessionCreateOnIssue")).toEqual(["externalUrls", "issueId"]);
    expect(declared("AgentSessionCreateOnComment")).toEqual(["commentId", "externalUrls"]);
    expect(declared("AgentSessionUpdateInput")).toEqual(["externalUrls", "plan"]);
    expect(declared("AgentActivityCreateInput")).toEqual([
      "agentSessionId",
      "content",
      "ephemeral",
      "signal",
    ]);
  });

  // `agentSessionUpdate(id:)` is the second, smaller divergence found on the same
  // mutation: upstream declares `id: String!`, and a nullable one lets the twin.
  it("agentSessionUpdate takes a non-null id argument, as Linear does", () => {
    const field = linearGraphQLSchema.getMutationType()?.getFields().agentSessionUpdate;
    const id = field?.args.find((argument) => argument.name === "id");
    expect(String(id?.type)).toBe("String!");
  });
});

/** The guard has to be able to FAIL: a subset check reads green whether it
 *  compared something or nothing, so this drives it against a wrong schema. */
describe("the subset guard fires on an invented member", () => {
  const wrong = buildSchema(`
    type Query { _unused: String }
    input AgentSessionUpdateInput { plan: String status: String id: String }
    type AgentActivity { id: ID! content: JSON! body: String! }
    enum AgentActivitySignal { stop halt }
    scalar JSON
  `);

  it("names the invented field on an input type", () => {
    const twin = twinMembers(wrong, "AgentSessionUpdateInput");
    expect(twin).not.toBeNull();
    // Exactly the pair measured, and nothing else.
    expect(inventedMembers(upstream.types.AgentSessionUpdateInput as UpstreamType, twin!)).toEqual([
      "id",
      "status",
    ]);
  });

  it("names the invented field on an output type", () => {
    const twin = twinMembers(wrong, "AgentActivity");
    expect(inventedMembers(upstream.types.AgentActivity as UpstreamType, twin!)).toEqual(["body"]);
  });

  it("names the invented member on an enum", () => {
    const twin = twinMembers(wrong, "AgentActivitySignal");
    expect(inventedMembers(upstream.types.AgentActivitySignal as UpstreamType, twin!)).toEqual(["halt"]);
  });

  it("stays green on the same shapes with the invented members removed", () => {
    const right = buildSchema(`
      type Query { _unused: String }
      input AgentSessionUpdateInput { plan: String }
      type AgentActivity { id: ID! content: JSON! }
      enum AgentActivitySignal { stop }
      scalar JSON
    `);
    for (const name of ["AgentSessionUpdateInput", "AgentActivity", "AgentActivitySignal"]) {
      expect(inventedMembers(upstream.types[name] as UpstreamType, twinMembers(right, name)!)).toEqual([]);
    }
  });
});
