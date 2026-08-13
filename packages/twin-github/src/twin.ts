// SPDX-License-Identifier: Apache-2.0
//
// The GitHub twin as a thin `@pome-sh/sdk` plugin (F-682). This manifest is
// pure declaration: domain factory, seed parser, tools, routes, and the
// wire-frozen GitHub shapes (FDRS-711 / F-712) — error envelopes, auth pins,
// healthz extras, the 501 unsupported envelope, the /_pome/access-control
// catalog route, the FDRS-402 tool_call_id tape pin. All mechanism (HTTP
// mount, auth, recorder + redaction, MCP dispatch, /_pome/*, admin gate,
// db driver) lives in the engine.

import { z } from "zod";
import {
  defineTwin,
  deriveMcpToolTable,
  type McpToolImplementation,
  type ToolCallContext,
  type TwinDefinition,
} from "@pome-sh/sdk";
import {
  createApp,
  twinBuildInfo,
  type RecorderStore,
  type SessionValue,
} from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import {
  githubAccessControlPayload,
  summarizeGitHubAccessControlCatalog,
} from "./access-control.js";
import { openGitHubCloneDatabase } from "./db.js";
import { GitHubDomain } from "./domain/index.js";
import { githubErrorEnvelope } from "./error-envelope.js";
import { githubError } from "./errors.js";
import { registerGitHubRoutes } from "./routes.js";
import { defaultSeedState, parseSeed, type ParsedGitHubStateSeed } from "./seed.js";
import { executeTool, githubToolFixture, isMutatingTool, toolArgumentSchemas } from "./tools.js";
import type { GitHubCloneDatabase, GitHubStateSeed } from "./types.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";

// The manifest seed "schema" is parseSeed itself, duck-typed to zod's
// parse/safeParse surface. The frozen /admin/seed wire behavior is exactly
// parseSeed's error split — schema violation → ZodError → 422 "Validation
// Failed"; empty body (the engine's readJson maps it to null) → SyntaxError
// → 400 "Problems parsing JSON" — which a plain zod schema cannot reproduce.
const seedParser = {
  parse(input: unknown): ParsedGitHubStateSeed {
    if (input === null || input === undefined) throw new SyntaxError("Problems parsing JSON");
    return parseSeed(input);
  },
  safeParse(input: unknown) {
    try {
      return { success: true as const, data: seedParser.parse(input) };
    } catch (error) {
      return { success: false as const, error };
    }
  },
} as unknown as z.ZodType<ParsedGitHubStateSeed>;

function actorFromSession(session: SessionValue | undefined): string | undefined {
  return typeof session?.login === "string" ? session.login : undefined;
}

// F-1325 — the tool table is the fixture. `deriveMcpToolTable` supplies every
// name, description and input schema (the twin-zod serialization emitted on
// both list surfaces since before the port) from
// `fixtures/mcp-tools-list.raw.json`, and refuses to build if the schemas in
// tools.ts and the fixture disagree in either direction.
const githubToolImplementations = Object.fromEntries(
  toolArgumentSchemas.map((def) => [
    def.name,
    {
      schema: def.schema as unknown as z.ZodType<unknown>,
      mutation: isMutatingTool(def.name),
      handler: (domain: GitHubDomain, args: unknown, ctx: ToolCallContext) =>
        executeTool(domain, def.name, args, ctx.reportDelta, {
          actor: actorFromSession(ctx.session),
        }),
    },
  ])
) as Record<string, McpToolImplementation<GitHubDomain>>;

export const githubTwinDefinition: TwinDefinition<GitHubCloneDatabase, ParsedGitHubStateSeed, GitHubDomain> =
  defineTwin({
    id: "github",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    implementation: "github_clone",
    packageName: "@pome-sh/twin-github",
    fidelity: { default: "semantic" },
    seed: seedParser,
    domain: ({ db, seed }) => {
      const domain = new GitHubDomain(db ?? openGitHubCloneDatabase());
      if (seed !== undefined) domain.seed(seed);
      return domain;
    },
    routes: registerGitHubRoutes,
    state: ({ domain }) => domain.exportState(),
    admin: {
      reset: ({ domain, reportDelta }) => {
        domain.seed(defaultSeedState(), reportDelta);
        return { ok: true, message: "GitHub twin state reset to default seed." };
      },
      seed: ({ domain, seed, reportDelta }) => {
        domain.seed(seed, reportDelta);
        return { ok: true, repositories: seed.repositories.length };
      },
      // F-1497: the admin-gate 403 body is BUILT HERE now, not defaulted in
      // `@pome-sh/sdk`. The gate is shared by all five twins, so its default
      // cannot carry GitHub's `documentation_url`/`status` leaves — and while
      // it defaulted, this twin's 403 said `documentation_url: ""`.
      //
      // The url is the GENERIC one on purpose. Real GitHub's measured 403s
      // name the operation (3 of 3, F-1490), but `/admin/*` is a twin-only
      // route with no GitHub operation behind it, which is the same reason
      // `/pulls/:n/diff` and `/pulls/:n/status` stay generic (divergence 32).
      forbidden: () => ({ status: 403, body: githubError("Forbidden", 403) }),
    },
    tools: deriveMcpToolTable(githubToolFixture, githubToolImplementations),
    // Frozen healthz shape: {ok, twin, implementation, fidelity, tools,
    // access_control, runtime} — no version field (github never carried it).
    healthz: () => ({
      fidelity: "semantic",
      access_control: summarizeGitHubAccessControlCatalog(),
    }),
    // Frozen per-session health shape: implementation + fidelity + runtime,
    // no version (pre-port /_pome/health).
    pomeHealth: () => ({
      implementation: "github_clone",
      fidelity: "semantic",
      runtime: twinBuildInfo("@pome-sh/twin-github"),
    }),
    // Frozen extra session route (CONTRACT.md per-twin table).
    pomeRoutes: {
      "access-control": () => githubAccessControlPayload(),
    },
    // FDRS-402 adapter-rich tape pin: x-pome-correlation-id persists as
    // tool_call_id on every recorded event (github's frozen tape shape).
    stampToolCallId: true,
    // Frozen JSON-RPC unknown-tool result text (the legacy /mcp/call surface
    // keeps the 422 validation envelope from errorEnvelope above).
    mcpUnknownTool: (name) => ({ message: `Unknown tool: ${name}` }),
    unsupported: () => unsupportedEnvelope,
    errorEnvelope: githubErrorEnvelope,
    auth: {
      // F-712 pins (wire-frozen): Bearer-header only (no extra token
      // resolvers), raw bearer rejected (allowRawBearer=false), sid mismatch
      // → 401 {message:"Forbidden"}, and an expired JWT rendering as
      // "Bad credentials". The pre-port explicit "Token expired" branch was
      // dead code: hono/jwt's verify throws JwtTokenExpired before the branch
      // was ever reached, so the wire always said "Bad credentials"
      // (pre-ruled: deleting it is zero wire diff).
      //
      // ── F-1497 changed two things about these bodies ────────────────────
      //
      // 1. They are built by `githubError` now instead of by hand, which is
      //    what gives them the `documentation_url` and `status` leaves real
      //    GitHub sends. Measured live 2026-08-13, 401 on `GET /user`:
      //    `{"message":…,"documentation_url":"https://docs.github.com/rest","status":"401"}`.
      //    The url is GitHub's GENERIC one and MUST STAY generic — GitHub
      //    names no operation on a 401 because authentication fails before
      //    dispatch (8 of 8 measured, F-1490), which is the half of
      //    divergence 32 that is a requirement rather than a gap. `githubError`
      //    defaults to exactly that url and this call passes no override.
      //
      // 2. A MISSING credential and a BAD one no longer say the same thing.
      //    Real GitHub, same probe: no `Authorization` header at all answers
      //    `Requires authentication`, a bad token answers `Bad credentials`.
      //    The engine already classifies the two (`no_token` vs `invalid`);
      //    this twin was collapsing them.
      providerToken: { provider: "github", prefixes: ["ghp_pome_", "github_pat_pome_"] },
      allowRawBearer: false,
      unauthorized: (kind) => ({
        status: 401,
        body: githubError(kind === "no_token" ? "Requires authentication" : "Bad credentials", 401),
      }),
      sidMismatch: () => ({
        status: 401,
        body: githubError("Forbidden", 401),
      }),
      sessionExtras: (claims) =>
        typeof claims.login === "string" && claims.login.length > 0 ? { login: claims.login } : {},
    },
  });

export type GitHubCloneAppOptions = {
  db?: GitHubCloneDatabase;
  seed?: GitHubStateSeed;
  recorder?: RecorderStore;
  runId?: string;
};

/** Assemble the GitHub twin app on the engine (in-process; no port bind). */
export function createGitHubCloneApp(options: GitHubCloneAppOptions = {}): Hono {
  return createApp(githubTwinDefinition, {
    db: options.db ?? openGitHubCloneDatabase(),
    recorder: options.recorder,
    runId: options.runId ?? "local",
    // Pre-port factory semantics: an explicit `db` carries its own state
    // (the boot path seeds before binding); otherwise seed the supplied or
    // default world.
    seed: options.db ? undefined : ((options.seed ?? defaultSeedState()) as ParsedGitHubStateSeed),
  });
}
