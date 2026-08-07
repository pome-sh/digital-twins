// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — twin-linear's HTTP input surface.
//
// Linear's API layer is GraphQL, so this twin's input surface has two halves
// that are read in two different ways, and only one of them belongs here.
//
//   * The ARGUMENTS an operation accepts come from `linearGraphQLSchema` — the
//     executable schema every `/graphql` request already runs against. They are
//     projected in `./graphql/argument-surface.ts`, not declared here: a second
//     declaration of the same arguments is exactly the drift this ticket
//     removes from the other four twins.
//   * The HTTP TRANSPORT still has real inputs of its own — the GraphQL
//     envelope (`query` / `variables` / `operationName`, in the query string on
//     GET and in the body on POST) and the four OAuth endpoints, which are
//     ordinary form-posted HTTP surfaces with nothing GraphQL about them. Those
//     were as undeclared as any of the four HTTP twins' routes, and they are
//     what this module declares.

import { z } from "zod";
import { declareRouteInputs, type RouteInputDeclaration } from "@pome-sh/sdk/route-inputs";

/**
 * The GraphQL request envelope. `variables` arrives as a JSON *string* on GET
 * (a query string cannot carry an object) and as a real object on POST; both
 * spellings are accepted, which is what every GraphQL client expects and what
 * the twin already did.
 */
const VARIABLES_STRING = z.string().optional();
const VARIABLES_OBJECT = z.union([z.record(z.string(), z.unknown()), z.string()]).optional();

/** PKCE + the authorization-request parameters, shared by authorize and its callback. */
const AUTHORIZE_PARAMS = {
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  actor: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
} as const;

export const LINEAR_ROUTES = {
  graphqlGet: declareRouteInputs({
    method: "GET",
    path: "/graphql",
    query: {
      query: z.string().optional(),
      variables: VARIABLES_STRING,
      operationName: z.string().optional(),
    },
  }),

  graphqlPost: declareRouteInputs({
    method: "POST",
    path: "/graphql",
    bodyEncoding: "form",
    body: {
      query: z.string().optional(),
      variables: VARIABLES_OBJECT,
      operationName: z.string().optional(),
    },
  }),

  oauthAuthorize: declareRouteInputs({
    method: "GET",
    path: "/oauth/authorize",
    query: { ...AUTHORIZE_PARAMS, response_type: z.string().optional() },
  }),

  oauthAuthorizeCallback: declareRouteInputs({
    method: "POST",
    path: "/oauth/authorize/callback",
    bodyEncoding: "form",
    // `user_ref` is the twin's own field: the consent page renders one form per
    // Linear user and posts back which one was picked. Real Linear has no
    // equivalent, and declaring it says so out loud.
    body: { ...AUTHORIZE_PARAMS, user_ref: z.string().optional() },
  }),

  oauthToken: declareRouteInputs({
    method: "POST",
    path: "/oauth/token",
    bodyEncoding: "form",
    // Client credentials arrive EITHER as HTTP Basic or as body fields, so both
    // are declared; `clientCredentials()` prefers the header.
    headers: { Authorization: z.string().optional() },
    body: {
      grant_type: z.string().optional(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
      code: z.string().optional(),
      redirect_uri: z.string().optional(),
      code_verifier: z.string().optional(),
      refresh_token: z.string().optional(),
      scope: z.string().optional(),
    },
  }),

  oauthRevoke: declareRouteInputs({
    method: "POST",
    path: "/oauth/revoke",
    bodyEncoding: "form",
    body: {
      token: z.string().optional(),
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
    },
  }),
} as const;

/**
 * Every HTTP route this twin serves. Read by the artifact emitter and by
 * `test/route-input-declarations.test.ts`'s 1:1 check against what the
 * registrars actually mount.
 */
export const LINEAR_ROUTE_INPUTS: readonly RouteInputDeclaration[] = Object.values(LINEAR_ROUTES);
