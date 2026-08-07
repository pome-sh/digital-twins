// SPDX-License-Identifier: Apache-2.0
import { getOperationAST, graphql, parse, type GraphQLError, type GraphQLFormattedError } from "graphql";
import type { Context } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import {
  UndeclaredInputError,
  mountDeclaredRoute,
  type DeclarableRouter,
  type DeclaredRouteInputs,
  type RouteInputDeclaration,
  type RouteInputSpec,
} from "@pome-sh/sdk/route-inputs";
import type { SessionValue } from "@pome-sh/sdk/server";
import type { LinearDomain } from "../domain/index.js";
import { LinearTwinError, badUserInput } from "../errors.js";
import { LINEAR_ROUTES } from "../route-inputs.js";
// GraphQL v16 dropped `formatError` on `graphql()` — project twin errors after execute.
import { byteLength } from "../ids.js";
import { actorFromSession } from "../identity.js";
import { linearStateDelta } from "../state.js";
import { GRAPHQL_QUERY_MAX_BYTES, GRAPHQL_SELECTION_DEPTH_MAX } from "../types.js";
import { createRootValue } from "./resolvers.js";
import { linearGraphQLSchema } from "./schema.js";

export function registerGraphqlRoutes(app: DeclarableRouter, ctx: RouteContext<LinearDomain>): void {
  mountDeclaredRoute(
    app,
    LINEAR_ROUTES.graphqlGet,
    ctx.recorder.handle({ mutation: false }, async (c) => {
      const { query } = await parseDeclared(LINEAR_ROUTES.graphqlGet, c);
      return executeRecordedGraphQL(ctx, c, query.query ?? "", {
        variables: parseVariables(query.variables),
        operationName: query.operationName,
      });
    })
  );

  mountDeclaredRoute(
    app,
    LINEAR_ROUTES.graphqlPost,
    ctx.recorder.handle({ mutation: false }, async (c) => {
      const { body } = await parseDeclared(LINEAR_ROUTES.graphqlPost, c);
      return executeRecordedGraphQL(ctx, c, body.query ?? "", {
        // Form-posted variables arrive as a JSON string, JSON-posted ones as an
        // object. The declaration accepts both spellings, so both are handled
        // here rather than at two content-type-sniffing call sites.
        variables: typeof body.variables === "string" ? parseVariables(body.variables) : body.variables,
        operationName: body.operationName,
      });
    })
  );
}

/**
 * Project the declaration's refusals into a GraphQL-shaped error.
 *
 * A transport key nobody declared is a client mistake, not a schema one, so it
 * answers `BAD_USER_INPUT` the same way a malformed query does — GraphQL has no
 * other channel for it.
 */
async function parseDeclared<S extends RouteInputSpec>(
  declaration: RouteInputDeclaration<S>,
  c: Context
): Promise<DeclaredRouteInputs<S>> {
  try {
    return await declaration.parse(c.req);
  } catch (error) {
    if (error instanceof UndeclaredInputError) {
      badUserInput(`Unknown ${error.location} parameter: ${error.first}`);
    }
    throw error;
  }
}

async function executeRecordedGraphQL(
  ctx: RouteContext<LinearDomain>,
  c: Context,
  query: string,
  opts: { variables?: Record<string, unknown>; operationName?: string }
) {
  const before = ctx.domain.exportState();
  const result = await runGraphQL(ctx.domain, c, query, opts);
  const wantsMutation = isMutationOperation(query, opts.operationName);
  const delta = wantsMutation
    ? linearStateDelta(before, ctx.domain.exportState())
    : null;
  return {
    status: result.errors ? 400 : 200,
    body: result,
    mutation: wantsMutation && delta !== null,
    delta: wantsMutation ? delta : null,
  };
}

async function runGraphQL(
  commands: LinearDomain,
  c: Context,
  query: string,
  opts: { variables?: Record<string, unknown>; operationName?: string }
) {
  if (!query) {
    return { errors: [{ message: "GraphQL query is required" }] };
  }
  if (byteLength(query) > GRAPHQL_QUERY_MAX_BYTES) {
    return {
      errors: [
        {
          message: `GraphQL query exceeds ${GRAPHQL_QUERY_MAX_BYTES} bytes`,
          extensions: { code: "BAD_USER_INPUT" },
        },
      ],
    };
  }
  try {
    assertSelectionDepth(query, GRAPHQL_SELECTION_DEPTH_MAX);
  } catch (error) {
    return {
      errors: [
        {
          message: error instanceof Error ? error.message : "Query too deep",
          extensions: { code: "BAD_USER_INPUT" },
        },
      ],
    };
  }

  const session = c.get("session") as SessionValue | undefined;
  const actor = actorFromSession(session);

  try {
    const result = await graphql({
      schema: linearGraphQLSchema,
      source: query,
      rootValue: createRootValue({ commands, actor }),
      contextValue: { commands, actor },
      variableValues: opts.variables,
      operationName: opts.operationName,
    });
    if (!result.errors?.length) return result;
    return {
      ...result,
      errors: result.errors.map(projectGraphQLError),
    };
  } catch (error) {
    if (error instanceof LinearTwinError) {
      return { errors: [error.toGraphQLError()] };
    }
    return {
      errors: [{ message: error instanceof Error ? error.message : "GraphQL error" }],
    };
  }
}

function projectGraphQLError(error: GraphQLError): GraphQLFormattedError {
  const original = error.originalError;
  if (original instanceof LinearTwinError) {
    return {
      message: original.message,
      locations: error.locations,
      path: error.path,
      extensions: original.toGraphQLError().extensions,
    };
  }
  return {
    message: error.message,
    locations: error.locations,
    path: error.path,
    ...(error.extensions ? { extensions: error.extensions } : {}),
  };
}

function isMutationOperation(source: string, operationName?: string): boolean {
  try {
    const document = parse(source);
    const operation = getOperationAST(document, operationName ?? null);
    return operation?.operation === "mutation";
  } catch {
    return /^\s*mutation\b/i.test(source);
  }
}

function parseVariables(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Cheap brace-depth check — not a full GraphQL parser. */
function assertSelectionDepth(query: string, max: number): void {
  // Strip block strings and quoted strings first so braces inside string
  // literals (e.g. `title: "}}}"`) don't skew the count.
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  let depth = 0;
  let maxSeen = 0;
  for (const ch of stripped) {
    if (ch === "{") {
      depth += 1;
      maxSeen = Math.max(maxSeen, depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  if (maxSeen > max) badUserInput(`GraphQL selection depth exceeds ${max}`);
}
