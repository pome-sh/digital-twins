// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — twin-linear's GraphQL argument surface, projected from the schema
// the twin executes against.
//
// This is the property the other four twins had to be rebuilt to reproduce: the
// arguments are readable with ZERO transcription, because `linearGraphQLSchema`
// is not a description of what `/graphql` accepts, it is what `/graphql` runs.
// A root-field argument that is not in this projection cannot be passed to the
// twin, and one that is in it cannot be refused, for the same structural reason
// `declareRouteInputs` gives the HTTP twins.
//
// pome-cloud has read this since F-1173, through a committed projection of its
// own regenerated from `graphql/schema.js`. This module exists so that all five
// twins publish through ONE seam — `packages/twin-*/route-inputs.json` — rather
// than four through a generated artifact and one through a bespoke fixture in
// the consuming repo.
//
// What is carried, and why nothing more: name, location (`argument`, always),
// required (the argument's non-null-ness) and type (its SDL type name, with
// list and non-null markers, which is the spelling pome-cloud's GraphQL adapter
// produces for the VENDOR side). Input-object internals are not descended into,
// on either side.

import {
  type GraphQLArgument,
  type GraphQLInputType,
  isListType,
  isNonNullType,
} from "graphql";
import type { DeclaredInput, GraphqlArgumentSurface } from "@pome-sh/sdk/route-inputs";
import { linearGraphQLSchema } from "./schema.js";

/** The prefix pome-cloud's GraphQL adapter keys root fields under. */
const GQL_PREFIX = "GQL";

/**
 * Every argument-bearing root field on the schema the twin serves, sorted.
 *
 * Root fields with no arguments (`viewer`, `organization`) are OMITTED rather
 * than emitted with `[]`: an empty list would make the comparator diff empty
 * against empty and count the surface as compared, which is the vacuous pass
 * the declared lane exists to remove.
 */
export function linearGraphqlArgumentSurfaces(): GraphqlArgumentSurface[] {
  const out: GraphqlArgumentSurface[] = [];
  for (const root of ["query", "mutation"] as const) {
    const type = root === "query" ? linearGraphQLSchema.getQueryType() : linearGraphQLSchema.getMutationType();
    if (!type) continue;
    for (const [name, field] of Object.entries(type.getFields())) {
      if (field.args.length === 0) continue;
      out.push({
        surface: `${GQL_PREFIX} ${name}`,
        root,
        inputs: field.args
          .map(declaredFromArgument)
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }
  return out.sort((a, b) => a.surface.localeCompare(b.surface));
}

function declaredFromArgument(argument: GraphQLArgument): DeclaredInput {
  return {
    name: argument.name,
    location: "argument",
    // An argument with a default value is not required even when its type is
    // non-null: the executor supplies the default, so a request omitting it
    // still runs. Asking the type alone would over-report requiredness.
    required: isNonNullType(argument.type) && argument.defaultValue === undefined,
    type: sdlTypeName(argument.type),
  };
}

/** `[ID!]!`-style SDL spelling, matching the vendor side's `type` strings. */
function sdlTypeName(type: GraphQLInputType): string {
  if (isNonNullType(type)) return `${sdlTypeName(type.ofType)}!`;
  if (isListType(type)) return `[${sdlTypeName(type.ofType)}]`;
  return type.name;
}
