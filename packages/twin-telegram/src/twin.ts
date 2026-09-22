// SPDX-License-Identifier: Apache-2.0
import { z, ZodError } from "zod";
import { defineTwin, type TwinDefinition } from "@pome-sh/sdk";
import { createApp, type RecorderStore } from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { openTelegramTwinDatabase, type TelegramTwinDatabase } from "./db.js";
import { TelegramDomain } from "./domain.js";
import { TwinError } from "./errors.js";
import { extractTelegramPathToken, telegramPathIdentity } from "./path-token.js";
import { registerTelegramRoutes } from "./routes.js";
import { defaultSeedState, parseSeed, type TelegramSeed } from "./seed.js";
import { telegramMcpToolFixture } from "./mcp-deferred-status.js";
import { telegramError } from "./serializers.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";
import { isLoopbackWebhookUrl, telegramUpdateRuntime, type TelegramWebhookDelivery } from "./updates.js";

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

export type TelegramTwinRuntimeOptions = {
  now?: () => number;
  webhookFixtures?: Record<string, TelegramWebhookDelivery>;
};

export function telegramTwinDefinition(
  db: TelegramTwinDatabase,
  runtimeOptions: TelegramTwinRuntimeOptions = {},
): TwinDefinition<TelegramTwinDatabase, TelegramSeed, TelegramDomain> {
  const fixtures = runtimeOptions.webhookFixtures ?? {};
  // Fixtures model a local receiver only. Never turn a public configured URL
  // into executable transport merely because a caller supplied a callback.
  const fixtureUrls = new Set(Object.keys(fixtures).filter(isLoopbackWebhookUrl));
  telegramUpdateRuntime(db, async (input) => {
    if (!fixtureUrls.has(input.url)) return { status: 503 };
    return fixtures[input.url]!(input);
  });
  return defineTwin({
    id: "telegram",
    version: process.env.POME_TWIN_VERSION ?? "0.0.0",
    implementation: "telegram_twin",
    packageName: "@pome-sh/twin-telegram",
    fidelity: { default: "semantic" },
    seed: {
      parse: (input: unknown) => parseSeed(input),
      safeParse: (input: unknown) => {
        try {
          return { success: true as const, data: parseSeed(input) };
        } catch (error) {
          return { success: false as const, error };
        }
      },
    } as unknown as z.ZodType<TelegramSeed>,
    domain: ({ seed }) => {
      const domain = new TelegramDomain(db, runtimeOptions.now, fixtureUrls);
      if (seed !== undefined) domain.seed(seed);
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
    // The status fixture is an explicit absence of a compliant tools/list;
    // it loads to an empty tool table until capture policy permits one.
    tools: telegramMcpToolFixture.tools,
    healthz: () => ({}),
    unsupported: () => unsupportedEnvelope,
    errorEnvelope: telegramErrorEnvelope,
    mountSessionAtRoot: true,
    auth: {
      requirePathSid: false,
      extractPathToken: extractTelegramPathToken,
      tokenResolvers: [extractTelegramPathToken],
      resolveCredential: (token, c) => {
        const found = new TelegramDomain(db, undefined, undefined, false).lookupBotToken(token);
        if (!found) return undefined;
        const pathSid = telegramPathIdentity(c).sid;
        return pathSid ? { ...found, sid: pathSid } : found;
      },
      unauthorized: () => ({ status: 401, body: telegramError(401, "Unauthorized") }),
      sidMismatch: () => ({ status: 403, body: telegramError(403, "Forbidden") }),
      sessionExtras: (claims) =>
        typeof claims.login === "string" && claims.login.length > 0 ? { login: claims.login } : {},
    },
  });
}

export type CreateTelegramTwinAppOptions = TelegramTwinRuntimeOptions & {
  db?: TelegramTwinDatabase;
  recorder?: RecorderStore;
  runId?: string;
  seed?: TelegramSeed;
};

export function createTelegramTwinApp(opts: CreateTelegramTwinAppOptions = {}): Hono {
  const db = opts.db ?? openTelegramTwinDatabase(":memory:");
  return createApp(telegramTwinDefinition(db, opts), {
    db,
    recorder: opts.recorder,
    runId: opts.runId ?? "spawn",
    seed: opts.seed,
  });
}
