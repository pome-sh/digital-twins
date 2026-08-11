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
import { routeInputDeclarer, type RouteInputDeclaration } from "@pome-sh/sdk/route-inputs";

/**
 * F-1372 — Linear ignores a request parameter it does not recognise on all six
 * of these routes, so this twin does too.
 *
 * Four of them are OAuth, where it is not even Linear's choice: RFC 6749 says
 * "The authorization server MUST ignore unrecognized request parameters" in
 * §3.1 for the authorization endpoint AND in §3.2 for the token endpoint, and
 * `/oauth/revoke` follows the token endpoint's conventions (RFC 7009). Real
 * Linear was measured obeying it on 2026-08-09: `/oauth/authorize` answered its
 * consent page identically with and without an unknown parameter (24,446 bytes
 * either way, differing only in a per-request CSP nonce), and `/oauth/token`
 * answered the same `invalid_client` both ways — the unknown parameter changed
 * nothing about either.
 *
 * The other two are `/graphql`, measured the same day: an unknown top-level
 * envelope key, and an unknown query-string key, each left Linear's answer
 * exactly as it was.
 *
 * F-1385 settled the one case that ruling did NOT cover. `extensions` is not an
 * unknown key Linear happens to reject — it is a key Linear specifically
 * parses, so it is DECLARED below and answered by
 * `./graphql/persisted-query.ts` rather than left to this disposition. The
 * transcript behind both is `docs/undeclared-route-inputs.md`.
 */
const declareInputs = routeInputDeclarer("ignore");

/**
 * The GraphQL request envelope. `variables` arrives as a JSON *string* on GET
 * (a query string cannot carry an object) and as a real object on POST; both
 * spellings are accepted, which is what every GraphQL client expects and what
 * the twin already did.
 */
const VARIABLES_STRING = z.string().optional();
const VARIABLES_OBJECT = z.union([z.record(z.string(), z.unknown()), z.string()]).optional();

/**
 * `extensions`, the envelope's fourth member — Apollo's automatic persisted
 * queries ride in it (F-1385).
 *
 * Deliberately permissive rather than shaped, on BOTH surfaces. Linear answers
 * a differently-worded 400 for each way an `extensions` value can be wrong — a
 * non-object, a recursively JSON-encoded string, query-string JSON that will
 * not decode — and it answers them itself, ahead of authentication. A zod
 * schema tight enough to reject those here would substitute the twin's
 * `BAD_USER_INPUT` envelope for the vendor's own message on every one of them,
 * which is a divergence manufactured by our type rule rather than measured.
 * So the declaration NAMES the input and `./graphql/persisted-query.ts`
 * answers it; the derived type is `null` because the wire really does accept
 * any JSON value here.
 */
const EXTENSIONS_STRING = z.string().optional();
const EXTENSIONS_ANY = z.unknown().optional();

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
  graphqlGet: declareInputs({
    method: "GET",
    path: "/graphql",
    query: {
      query: z.string().optional(),
      variables: VARIABLES_STRING,
      operationName: z.string().optional(),
      extensions: EXTENSIONS_STRING,
    },
  }),

  graphqlPost: declareInputs({
    method: "POST",
    path: "/graphql",
    bodyEncoding: "form",
    body: {
      query: z.string().optional(),
      variables: VARIABLES_OBJECT,
      operationName: z.string().optional(),
      extensions: EXTENSIONS_ANY,
    },
  }),

  oauthAuthorize: declareInputs({
    method: "GET",
    path: "/oauth/authorize",
    query: { ...AUTHORIZE_PARAMS, response_type: z.string().optional() },
  }),

  oauthAuthorizeCallback: declareInputs({
    method: "POST",
    path: "/oauth/authorize/callback",
    bodyEncoding: "form",
    // `user_ref` is the twin's own field: the consent page renders one form per
    // Linear user and posts back which one was picked. Real Linear has no
    // equivalent, and declaring it says so out loud.
    body: { ...AUTHORIZE_PARAMS, user_ref: z.string().optional() },
  }),

  oauthToken: declareInputs({
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

  oauthRevoke: declareInputs({
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
