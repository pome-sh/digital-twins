// SPDX-License-Identifier: Apache-2.0
import { z, ZodError } from "zod";
import {
  defineTwin,
  deriveMcpToolTable,
  type McpToolImplementation,
  type ToolCallContext,
  type TwinDefinition,
} from "@pome-sh/sdk";
import { createApp, type RecorderStore } from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { openTelegramTwinDatabase, type TelegramTwinDatabase } from "./db.js";
import { TelegramDomain } from "./domain.js";
import { TwinError } from "./errors.js";
import { extractTelegramPathToken } from "./path-token.js";
import { registerTelegramRoutes } from "./routes.js";
import { defaultSeedState, type TelegramSeed } from "./seed.js";
import { telegramError } from "./serializers.js";
import { executeTool, isMutatingTool, telegramToolFixture, toolSchemas } from "./tools.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";

function zodIssues(err: unknown): Array<{ path: ReadonlyArray<PropertyKey>; message: string }> | undefined {
  if (err instanceof ZodError) return err.issues;
  if (err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as unknown as ZodError).issues;
  }
  return undefined;
}

function telegramErrorEnvelope(err: unknown): { status: number; body: unknown } {
  if (err instanceof TwinError) {
    return { status: err.status, body: telegramError(err.errorCode, err.description) };
  }
  const issues = zodIssues(err);
  if (issues) {
    return {
      status: 400,
      body: telegramError(400, issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")),
    };
  }
  return {
    status: 500,
    body: telegramError(500, err instanceof Error ? err.message : "internal_error"),
  };
}

const implementations = Object.fromEntries(
  Object.entries(toolSchemas).map(([name, schema]) => [
    name,
    {
      schema: schema as unknown as z.ZodType<unknown>,
      mutation: isMutatingTool(name),
      handler: (domain: TelegramDomain, args: unknown, ctx: ToolCallContext) =>
        executeTool(domain, name, args as Record<string, unknown>, ctx),
    },
  ]),
) as Record<string, McpToolImplementation<TelegramDomain>>;

function lookupBot(db: TelegramTwinDatabase, token: string) {
  const row = db.prepare("SELECT id, username FROM bots WHERE token = ?").get(token) as
    | { id: number; username: string }
    | undefined;
  if (!row) return undefined;
  return { sid: "local", bot_id: row.id, login: row.username };
}

export function telegramTwinDefinition(
  db: TelegramTwinDatabase,
): TwinDefinition<TelegramTwinDatabase, TelegramSeed, TelegramDomain> {
  return defineTwin({
    id: "telegram",
    version: process.env.POME_TWIN_VERSION ?? "0.0.0",
    implementation: "telegram_twin",
    packageName: "@pome-sh/twin-telegram",
    fidelity: { default: "semantic" },
    seed: z.unknown() as unknown as z.ZodType<TelegramSeed>,
    domain: ({ seed }) => {
      const domain = new TelegramDomain(db);
      domain.seed(seed !== undefined ? seed : defaultSeedState());
      return domain;
    },
    routes: registerTelegramRoutes,
    state: ({ domain }) => domain.exportState(),
    admin: {
      reset: ({ domain }) => {
        domain.resetToDefault(defaultSeedState);
        return { ok: true };
      },
      seed: ({ domain, seed }) => {
        domain.applySeed(seed);
        return { ok: true };
      },
      errorEnvelope: (err) => telegramErrorEnvelope(err),
      forbidden: () => ({ status: 403, body: telegramError(403, "Forbidden") }),
    },
    tools: deriveMcpToolTable(telegramToolFixture, implementations),
    healthz: () => ({}),
    unsupported: () => unsupportedEnvelope,
    errorEnvelope: telegramErrorEnvelope,
    mountSessionAtRoot: true,
    auth: {
      requirePathSid: false,
      extractPathToken: extractTelegramPathToken,
      tokenResolvers: [extractTelegramPathToken],
      resolveCredential: (token) => lookupBot(db, token),
      unauthorized: () => ({ status: 401, body: telegramError(401, "Unauthorized") }),
      sidMismatch: () => ({ status: 403, body: telegramError(403, "Forbidden") }),
      sessionExtras: (claims) =>
        typeof claims.login === "string" && claims.login.length > 0 ? { login: claims.login } : {},
    },
  });
}

export type CreateTelegramTwinAppOptions = {
  db?: TelegramTwinDatabase;
  recorder?: RecorderStore;
  runId?: string;
  seed?: TelegramSeed;
};

export function createTelegramTwinApp(opts: CreateTelegramTwinAppOptions = {}): Hono {
  const db = opts.db ?? openTelegramTwinDatabase(":memory:");
  return createApp(telegramTwinDefinition(db), {
    db,
    recorder: opts.recorder,
    runId: opts.runId ?? "spawn",
    seed: opts.seed,
  });
}
