// SPDX-License-Identifier: Apache-2.0
//
// `pome twin start <twin>` — the docker-free front door. Boots any
// of the three twins as a long-lived foreground server (Ctrl-C to stop) on
// the same in-process boot path `pome run --local` uses (`bootTwin`), so
// `npx @pome-sh/cli twin start github` serves the identical control plane
// the packaged twin entries serve, with zero installs beyond Node ≥ 24.
//
// Auth: the twin's bearer middleware reads `TWIN_AUTH_SECRET` from the env
// (engine contract). The CLI resolves the secret the same way an operator
// would — an env-injected `TWIN_AUTH_SECRET` always wins, else the secret a
// prior twin boot persisted at `.pome-data/<twin>/secret` (the twin writes it;
// `POME_TWIN_DATA_DIR` overrides the directory) is reused, else a per-boot
// ephemeral secret is generated. Loopback binds deliberately do NOT persist
// a new secret file — that mirrors the twin's own loopback carve-out, and the
// ready-to-use JWT is reprinted on every boot anyway.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { parse as parseYaml } from "yaml";
import {
  defaultPortFor,
  isTwinName,
  TWIN_NAMES,
  TWIN_REGISTRY,
  type TwinName,
} from "./registry.js";
import { bootTwin } from "./twinHarness.js";

/** The fixed session id a standalone twin serves under (`/s/standalone`). */
const STANDALONE_SID = "standalone";

export type StandaloneAuthSecret = {
  secret: string;
  source: "env" | "persisted" | "ephemeral";
  /** Set when `source` is "persisted": the file the secret was read from. */
  path?: string;
};

/**
 * Read side of the boot-secret contract. Resolution order:
 *   1. env `TWIN_AUTH_SECRET` (always wins — same rule as the twin boots)
 *   2. the persisted `.pome-data/<twin>/secret` (`POME_TWIN_DATA_DIR`
 *      overrides the directory); blank file = absent, < 32 chars = loud
 *      error (never mint against a weak HS256 key, never guess)
 *   3. a fresh per-boot secret, NOT persisted (loopback dev path)
 */
export function resolveStandaloneAuthSecret(
  twin: string,
  env: NodeJS.ProcessEnv = process.env,
): StandaloneAuthSecret {
  const injected = env.TWIN_AUTH_SECRET;
  if (injected) return { secret: injected, source: "env" };

  const dataDir = env.POME_TWIN_DATA_DIR || join(".pome-data", twin);
  const secretPath = join(dataDir, "secret");
  let raw: string | undefined;
  try {
    raw = readFileSync(secretPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const persisted = raw?.trim() ?? "";
  if (persisted.length >= 32) {
    return { secret: persisted, source: "persisted", path: secretPath };
  }
  if (persisted.length > 0) {
    // Same rule as the engine's readSecretFile: a short secret is
    // operator content we must not silently serve or regenerate over.
    throw new Error(
      `The persisted secret at ${secretPath} is shorter than 32 chars — fix or delete the file, or inject TWIN_AUTH_SECRET.`,
    );
  }
  return { secret: randomBytes(32).toString("hex"), source: "ephemeral" };
}

/** Where the world a standalone twin booted came from. Printed on boot so the
 *  answer to "did my seed land?" does not require reading `/_pome/state`. */
export type StandaloneSeed = {
  seedState: unknown;
  source: "file" | "env" | "default";
  /** Set when `source` is "file": the path the world was read from. */
  path?: string;
};

/**
 * Read side of the world contract, mirroring `resolveStandaloneAuthSecret`:
 *   1. `--seed <path>` (JSON or YAML — JSON is a YAML subset, one parser)
 *   2. env `POME_SEED_JSON` — the SAME channel the cloud sets on a pod, so a
 *      world that boots hosted boots here. Before this it was read by the twin
 *      and silently discarded by this command, which boots through `bootTwin`
 *      rather than the twin's own `loadSeedFromEnv`.
 *   3. the twin's default world
 *
 * The twin's own `parseSeed` is the arbiter in both non-default cases: a
 * user-authored world is refused HERE, naming its own bad field, rather than
 * reaching SQLite (github) or throwing an un-attributed zod error mid-boot.
 */
export async function resolveStandaloneSeed(
  twin: TwinName,
  seedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StandaloneSeed> {
  const entry = TWIN_REGISTRY[twin];

  if (seedPath !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(seedPath, "utf8");
    } catch (err) {
      throw new Error(
        `pome twin start --seed: cannot read ${seedPath}: ${(err as Error).message}`,
      );
    }
    return {
      seedState: await parseWorld(entry, raw, `--seed ${seedPath}`),
      source: "file",
      path: seedPath,
    };
  }

  const fromEnv = env.POME_SEED_JSON;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { seedState: await parseWorld(entry, fromEnv, "POME_SEED_JSON"), source: "env" };
  }

  return { seedState: await entry.defaultSeed(), source: "default" };
}

async function parseWorld(
  entry: (typeof TWIN_REGISTRY)[TwinName],
  raw: string,
  origin: string,
): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`${origin} is not valid JSON or YAML: ${(err as Error).message}`);
  }
  try {
    return await entry.parseSeed(parsed);
  } catch (err) {
    throw new Error(`${origin} is not a world this twin can boot: ${(err as Error).message}`);
  }
}

export async function runTwinStartCommand(
  name: string,
  options: { port?: string; seed?: string },
): Promise<void> {
  if (!isTwinName(name)) {
    throw new Error(`Unknown twin '${name}'. Supported: ${TWIN_NAMES.join(", ")}.`);
  }
  // `PORT` wins when set (contract suite / packaged entries). Gmail defaults
  // to 3336 via GMAIL_TWIN_PORT; other twins keep 3333.
  const portRaw = options.port ?? defaultPortFor(name, process.env);
  const port = Number(portRaw);
  // Port 0 (ephemeral) is rejected: every printed URL and the status-file
  // token would name a port nobody can discover from outside the process.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`pome twin start: invalid --port "${portRaw}"`);
  }

  // Resolve the world BEFORE the auth secret and the listener: a refused seed
  // must not persist a secret file or leave a bound port behind.
  const world = await resolveStandaloneSeed(name, options.seed);

  const resolved = resolveStandaloneAuthSecret(name);
  // The in-process twin's auth middleware (resolveAuthSecret) reads the env;
  // pinning the resolved secret here is what makes the minted JWT and the
  // running twin agree.
  process.env.TWIN_AUTH_SECRET = resolved.secret;

  const baseUrl = `http://127.0.0.1:${port}`;
  const harness = await bootTwin({
    twin: name,
    seedState: world.seedState,
    runId: STANDALONE_SID,
    twinBaseUrl: baseUrl,
  });
  const token = await sign(
    {
      sid: STANDALONE_SID,
      team_id: "tm_local",
      // Same claims `pome run --local` mints: `login` so the GitHub REST
      // merge gate resolves the agent user; twin-supplied extras (stripe's
      // `account_id`) so the token lands on the seeded account.
      login: "pome-agent",
      ...(harness.extraClaims ?? {}),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    resolved.secret,
  );

  const restUrl = `${baseUrl}/s/${STANDALONE_SID}`;
  const mcpUrl = `${restUrl}/mcp`;
  const server = serve({ fetch: harness.app.fetch, port, hostname: "127.0.0.1" });

  try {
    await mkdir(".pome", { recursive: true });
    await writeFile(
      ".pome/twin-status.json",
      JSON.stringify(
        { name, url: restUrl, rest_url: restUrl, mcp_url: mcpUrl, auth_token: token },
        null,
        2,
      ),
    );
  } catch (err) {
    // Boot fails loudly or not at all: without this, the rejection leaves a
    // bound listener keeping the process alive behind the error message.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.close();
    throw err;
  }

  console.log(`Pome ${name} twin listening at ${restUrl}`);
  // "Did my world land?" is the question a user-authored seed creates, and the
  // twin cannot answer it after the fact — every world looks like a world.
  if (world.source === "file") {
    console.log(`World: seeded from ${world.path}.`);
  } else if (world.source === "env") {
    console.log("World: seeded from POME_SEED_JSON (--seed <path> overrides it).");
  } else {
    console.log(`World: the ${name} twin's default (pass --seed <path> for your own).`);
  }
  if (resolved.source === "persisted") {
    console.log(
      `Auth: using the persisted secret from ${resolved.path} (an env-injected TWIN_AUTH_SECRET overrides it).`,
    );
  }
  console.log(`POME_${harness.envName}_REST_URL=${restUrl}`);
  console.log(`POME_${harness.envName}_MCP_URL=${mcpUrl}`);
  console.log(`POME_AUTH_TOKEN=${token}`);
  if (harness.tokenEnvName) console.log(`${harness.tokenEnvName}=${token}`);
  // F28 — every `/s/<sid>/*` endpoint requires a Bearer JWT, including
  // /s/standalone/healthz. New users curling the printed `${restUrl}` get
  // HTTP 401 and assume the twin is broken. The unauth liveness probe lives
  // at the root `/healthz`. Print the curl command so copy-paste debugging
  // works without a JWT.
  console.log(`Health check (no auth): curl ${baseUrl}/healthz`);
  console.log("Ctrl-C to stop.");

  // Foreground server: the bound socket keeps the event loop alive until a
  // signal lands. Graceful path closes the listener, then flushes the
  // recorder and releases the SQLite handle via the harness.
  const shutdown = () => {
    void (async () => {
      // `close()` alone waits for in-flight keep-alive connections, so a
      // stuck client would turn Ctrl-C into a hang: sever connections first,
      // and keep an unref'd hard deadline in case a close callback never
      // resolves anyway.
      const hardExit = setTimeout(() => process.exit(1), 10_000);
      hardExit.unref();
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
