// SPDX-License-Identifier: Apache-2.0
import { graphql } from "graphql";
import type { Context } from "hono";
import type { SessionValue } from "@pome-sh/sdk/server";
import type { LinearCommands } from "../commands/index.js";
import { LinearTwinError, badUserInput } from "../errors.js";
import { byteLength } from "../ids.js";
import {
  GRAPHQL_QUERY_MAX_BYTES,
  GRAPHQL_SELECTION_DEPTH_MAX,
  DEFAULT_LINEAR_EMAIL,
} from "../types.js";
import { createRootValue } from "./resolvers.js";
import { linearGraphQLSchema } from "./schema.js";

export function registerGraphqlRoutes(
  app: { get: Function; post: Function },
  commands: LinearCommands
): void {
  app.get("/graphql", async (c: Context) => {
    const result = await runGraphQL(commands, c, c.req.query("query") ?? "", {
      variables: parseVariables(c.req.query("variables")),
      operationName: c.req.query("operationName") ?? undefined,
    });
    return c.json(result, result.errors ? 400 : 200);
  });

  app.post("/graphql", async (c: Context) => {
    const body = await readGraphQLBody(c);
    const result = await runGraphQL(commands, c, body.query, {
      variables: body.variables,
      operationName: body.operationName,
    });
    return c.json(result, result.errors ? 400 : 200);
  });
}

async function runGraphQL(
  commands: LinearCommands,
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
  const actor = {
    userId: typeof session?.linear_user_id === "string" ? session.linear_user_id : undefined,
    email:
      typeof session?.linear_email === "string"
        ? session.linear_email
        : DEFAULT_LINEAR_EMAIL,
    scopes: Array.isArray(session?.scopes) ? (session.scopes as string[]) : undefined,
  };

  try {
    return await graphql({
      schema: linearGraphQLSchema,
      source: query,
      rootValue: createRootValue({ commands, actor }),
      contextValue: { commands, actor },
      variableValues: opts.variables,
      operationName: opts.operationName,
    });
  } catch (error) {
    if (error instanceof LinearTwinError) {
      return { errors: [error.toGraphQLError()] };
    }
    return {
      errors: [{ message: error instanceof Error ? error.message : "GraphQL error" }],
    };
  }
}

async function readGraphQLBody(c: Context): Promise<{
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await c.req.parseBody();
    return {
      query: typeof body.query === "string" ? body.query : "",
      variables: parseVariables(typeof body.variables === "string" ? body.variables : undefined),
      operationName:
        typeof body.operationName === "string" && body.operationName
          ? body.operationName
          : undefined,
    };
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    query: typeof body.query === "string" ? body.query : "",
    variables: isRecord(body.variables) ? body.variables : undefined,
    operationName: typeof body.operationName === "string" ? body.operationName : undefined,
  };
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
  let depth = 0;
  let maxSeen = 0;
  for (const ch of query) {
    if (ch === "{") {
      depth += 1;
      maxSeen = Math.max(maxSeen, depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  if (maxSeen > max) badUserInput(`GraphQL selection depth exceeds ${max}`);
}
