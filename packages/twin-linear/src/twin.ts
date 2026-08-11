// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { defineTwin, type TwinDefinition } from "@pome-sh/sdk";
import { createApp, type RecorderStore } from "@pome-sh/sdk/server";
import { Hono, type Context } from "hono";
import { resolveLinearCredential } from "./auth-credential.js";
import { LinearDomain } from "./domain/index.js";
import { openLinearTwinDatabase } from "./db.js";
import { linearErrorEnvelope, unauthorizedEnvelope, unsupportedEnvelope } from "./errors.js";
import { checkPersistedQuery, type PersistedQueryAnswer } from "./graphql/persisted-query.js";
import { LINEAR_ROUTES } from "./route-inputs.js";
import { LINEAR_MCP_TOOL_COUNT, linearTools } from "./mcp.js";
import { registerOAuthRoutes } from "./oauth/routes.js";
import { projectLinearRecording } from "./recording.js";
import { registerLinearRoutes } from "./routes.js";
import { defaultSeedState, linearSeedSchema, type ParsedLinearStateSeed } from "./seed.js";
import { linearStateDelta } from "./state.js";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_SCOPES,
  LINEAR_PROVIDER_TOKEN_PREFIX,
  type LinearStateSeed,
  type LinearTwinDatabase,
} from "./types.js";

const seedSchema = z.preprocess(
  (value) => (value === null || value === undefined ? defaultSeedState() : value),
  linearSeedSchema
) as unknown as z.ZodType<ParsedLinearStateSeed>;

export function createLinearTwinDefinition(
  db: LinearTwinDatabase
): TwinDefinition<LinearTwinDatabase, ParsedLinearStateSeed, LinearDomain> {
  return defineTwin({
    id: "linear",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    implementation: "linear_twin",
    packageName: "@pome-sh/twin-linear",
    fidelity: { default: "semantic" },
    seed: seedSchema,
    domain: ({ db: injected, seed }) => {
      if (injected && injected !== db) {
        throw new Error(
          "twin-linear: the db passed to createApp/serve must be the db the definition was created with"
        );
      }
      const domain = new LinearDomain(db);
      if (seed) domain.seed(seed);
      return domain;
    },
    routes: registerLinearRoutes,
    tools: linearTools,
    state: ({ domain }) => domain.exportState(),
    admin: {
      reset: ({ domain, reportDelta }) => {
        const before = domain.exportState();
        domain.resetToDefault();
        reportDelta(linearStateDelta(before, domain.exportState()));
        return { ok: true };
      },
      seed: ({ domain, seed, reportDelta }) => {
        const before = domain.exportState();
        domain.seed(seed);
        reportDelta(linearStateDelta(before, domain.exportState()));
        return { ok: true };
      },
    },
    recordingProjection: projectLinearRecording,
    errorEnvelope: linearErrorEnvelope,
    unsupported: ({ method, path }) => unsupportedEnvelope(method, path),
    healthz: () => ({
      fidelity: "semantic",
      tools: LINEAR_MCP_TOOL_COUNT,
    }),
    mountSessionAtRoot: true,
    auth: {
      providerToken: { provider: "linear", prefixes: [LINEAR_PROVIDER_TOKEN_PREFIX] },
      requirePathSid: false,
      allowRawBearer: true,
      resolveCredential: (token) => resolveLinearCredential(db, token),
      unauthorized: () => unauthorizedEnvelope("Bad credentials"),
      sidMismatch: () => unauthorizedEnvelope("Session id mismatch"),
      sessionExtras: (claims) => ({
        linear_email:
          typeof claims.linear_email === "string" && claims.linear_email.length > 0
            ? claims.linear_email.toLowerCase()
            : DEFAULT_LINEAR_EMAIL,
        scopes: [...DEFAULT_SCOPES],
      }),
      providerSession: (sid) => ({
        linear_email: DEFAULT_LINEAR_EMAIL,
        via: "provider_token",
        sid,
        scopes: [...DEFAULT_SCOPES],
      }),
    },
  });
}

export type CreateLinearTwinAppOptions = {
  db?: LinearTwinDatabase;
  recorder?: RecorderStore;
  runId?: string;
  seed?: LinearStateSeed;
  noSeed?: boolean;
};

/**
 * Mount OAuth outside bearerAuth. The engine's session router (including
 * mountSessionAtRoot) requires a bearer; Linear authorize/token/revoke are
 * public HTTP surfaces.
 */
export function withPublicOAuth(app: Hono, db: LinearTwinDatabase): Hono {
  const root = new Hono();
  registerOAuthRoutes(root, new LinearDomain(db));
  root.route("/", app);
  return root;
}

/**
 * Answer `extensions` ahead of `bearerAuth`, because Linear answers it ahead of
 * authentication (F-1385).
 *
 * The ordering is the fix, not a detail. Linear returns its 400 for an
 * unsatisfiable persisted query with no credential at all, while the same
 * request without `extensions` has to reach the auth check to earn its 401. A
 * twin that rejected after its own auth check would show an agent sending an
 * APQ payload with a stale token a 401 where Linear shows a 400 — the same
 * divergence F-1385 exists to close, in a form that is harder to see. So the
 * gate is mounted the way `withPublicOAuth` mounts the OAuth endpoints: on a
 * router wrapped AROUND the engine's session app, whose `bearerAuth` has not
 * run yet. `test/route-input-declarations.test.ts` pins it with a deliberately
 * bad token so the next refactor cannot quietly move it.
 *
 * Consequences of sitting outside the session, both deliberate:
 *
 *   * The gate's answers are not on the recorder tape, exactly like the 401s
 *     from `bearerAuth` they stand in front of and like the four OAuth routes.
 *     Anything that reaches the handler behind it is recorded as ever.
 *   * It NEVER reports a malformed request. A body that will not decode, or a
 *     declared input that fails its schema, is handed on to the recorded
 *     handler, which answers it through the twin's own error envelope.
 */
function withPersistedQueryGate(app: Hono): Hono {
  const root = new Hono();
  // Both declarations carry the same path, and the engine answers it at the
  // root and under `/s/:sid` (`mountSessionAtRoot`), so the gate covers both.
  const path = LINEAR_ROUTES.graphqlPost.path;
  for (const mount of [path, `/s/:sid${path}`]) {
    root.use(mount, async (c, next) => {
      const answer = await persistedQueryAnswer(c);
      if (!answer) return next();
      return c.json(answer.body as never, answer.status as never);
    });
  }
  root.route("/", app);
  return root;
}

/** The gate's verdict for one request, or `null` to let it through. */
async function persistedQueryAnswer(c: Context): Promise<PersistedQueryAnswer> {
  try {
    if (c.req.method === "GET") {
      const { query } = await LINEAR_ROUTES.graphqlGet.parse(c.req);
      return checkPersistedQuery({
        query: query.query,
        extensions: query.extensions,
        location: "query",
      });
    }
    if (c.req.method === "POST") {
      const { body } = await LINEAR_ROUTES.graphqlPost.parse(c.req);
      return checkPersistedQuery({
        query: body.query,
        extensions: body.extensions,
        location: "body",
      });
    }
    // Any other verb falls to the engine's 501 catch-all, which is its answer.
    return null;
  } catch {
    // Not the gate's business — see the note above. `parse()` is called again
    // by the handler behind this middleware, off hono's cached body, and the
    // failure is reported there through the twin's error envelope.
    return null;
  }
}

export function createLinearTwinApp(options: CreateLinearTwinAppOptions = {}): Hono {
  const db = options.db ?? openLinearTwinDatabase(":memory:");
  const definition = createLinearTwinDefinition(db);
  const seed = options.noSeed
    ? undefined
    : ((options.seed ?? (options.db ? undefined : defaultSeedState())) as ParsedLinearStateSeed | undefined);
  const app = createApp(definition, {
    db,
    recorder: options.recorder,
    runId: options.runId ?? "spawn",
    seed,
  });
  return withPersistedQueryGate(withPublicOAuth(app, db));
}
