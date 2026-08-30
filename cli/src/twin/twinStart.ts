// SPDX-License-Identifier: Apache-2.0
//
// `pome twin start <twin>` — the docker-free front door. Boots any
// of the five twins as a long-lived foreground server (Ctrl-C to stop) on
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
import {
  defaultPortFor,
  isTwinName,
  TWIN_NAMES,
  TWIN_REGISTRY,
  type TwinName,
} from "./registry.js";
import {
  parseSeedFileText,
  readSeedFileText,
  seedForTwin,
  soleTwinOf,
  twinsNamedBy,
} from "./seedFile.js";
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

/** Where the seed a standalone twin booted came from. Printed on boot so the
 *  answer to "did my seed land?" does not require reading `/_pome/state`. */
export type StandaloneSeed = {
  seedState: unknown;
  source: "file" | "env" | "default";
  /** Set when `source` is "file": the path the seed was read from. */
  path?: string;
};

/**
 * Read side of the seed contract, mirroring `resolveStandaloneAuthSecret`:
 *   1. `--seed <path>` (JSON or YAML — JSON is a YAML subset, one parser)
 *   2. env `POME_SEED_JSON` — the SAME channel the cloud sets on a pod, so a
 *      seed that boots hosted boots here. Before this it was read by the twin
 *      and silently discarded by this command, which boots through `bootTwin`
 *      rather than the twin's own `loadSeedFromEnv`.
 *   3. the twin's default seed
 *
 * Both authored cases go through `seedFile.ts`, so a flat file and a per-twin
 * envelope are the same door, and the twin's own `parseSeed` is the arbiter: a
 * user-authored seed is refused HERE, naming its own bad field, rather than
 * reaching SQLite (github) or throwing an un-attributed zod error mid-boot.
 *
 * `seedText` is the already-read contents of `seedPath`, for the caller that had
 * to read the file BEFORE it knew which twin to start (`--seed` alone, with the
 * `<name>` argument omitted). Passing it keeps that a single read.
 */
export async function resolveStandaloneSeed(
  twin: TwinName,
  seedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  seedText?: string,
): Promise<StandaloneSeed> {
  if (seedPath !== undefined) {
    const raw = seedText ?? readSeedFileText(seedPath, "pome twin start --seed");
    const origin = `--seed ${seedPath}`;
    return {
      seedState: await seedForTwin(parseSeedFileText(raw, origin), twin, origin),
      source: "file",
      path: seedPath,
    };
  }

  const fromEnv = env.POME_SEED_JSON;
  if (fromEnv !== undefined && fromEnv !== "") {
    return {
      seedState: await seedForTwin(
        parseSeedFileText(fromEnv, "POME_SEED_JSON"),
        twin,
        "POME_SEED_JSON",
      ),
      source: "env",
    };
  }

  return { seedState: await TWIN_REGISTRY[twin].defaultSeed(), source: "default" };
}

/**
 * Which twin `pome twin start` is starting.
 *
 * The `<name>` argument stays the plain answer. It is optional only when a seed
 * file supplies one instead — an envelope naming exactly one twin already says
 * which twin it is for, and making the reader repeat it is a second place to get
 * it wrong. Anything less certain than that is an error naming what is missing.
 */
export function resolveStandaloneTwin(
  name: string | undefined,
  seedPath: string | undefined,
  seedText: string | undefined,
): TwinName {
  if (name !== undefined) {
    if (!isTwinName(name)) {
      throw new Error(`Unknown twin '${name}'. Supported: ${TWIN_NAMES.join(", ")}.`);
    }
    return name;
  }
  if (seedPath === undefined || seedText === undefined) {
    throw new Error(
      `pome twin start: name a twin (${TWIN_NAMES.join(", ")}), or pass a --seed file whose envelope names exactly one.`,
    );
  }
  const origin = `--seed ${seedPath}`;
  const file = parseSeedFileText(seedText, origin);
  const sole = soleTwinOf(file);
  if (sole !== undefined) return sole;
  const named = twinsNamedBy(file);
  throw new Error(
    named.length === 0
      ? `${origin} is a flat seed, so it does not name a twin. Pass the name: pome twin start <${TWIN_NAMES.join("|")}> --seed ${seedPath}`
      : `${origin} names ${named.length} twins (${named.join(", ")}), so it does not say which one to start. Pass the name: pome twin start ${named[0]} --seed ${seedPath}`,
  );
}

export async function runTwinStartCommand(
  nameArg: string | undefined,
  options: { port?: string; seed?: string },
): Promise<void> {
  // Read the seed file BEFORE resolving the twin: with `<name>` omitted, the
  // file is what names it. One read feeds both.
  const seedText =
    options.seed === undefined
      ? undefined
      : readSeedFileText(options.seed, "pome twin start --seed");
  const name = resolveStandaloneTwin(nameArg, options.seed, seedText);
  // `PORT` wins when set (contract suite / packaged entries); gmail and linear
  // then honor their own override (`defaultPortFor`), other twins keep 3333.
  const portRaw = options.port ?? defaultPortFor(name, process.env);
  const port = Number(portRaw);
  // Port 0 (ephemeral) is rejected: every printed URL and the status-file
  // token would name a port nobody can discover from outside the process.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`pome twin start: invalid --port "${portRaw}"`);
  }

  // Resolve the seed BEFORE the auth secret and the listener: a refused seed
  // must not persist a secret file or leave a bound port behind.
  const world = await resolveStandaloneSeed(name, options.seed, process.env, seedText);

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
    // `serve()` calls listen() and attaches no `error` listener, and listen is
    // async: without this await, an EADDRINUSE lands as an uncaught `error`
    // event AFTER the status file and the whole banner have been written, so
    // the reader gets a stack trace under a token that never worked.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(
                `pome twin start: port ${port} is already in use — pass --port <port>, or stop the twin using it.`,
              )
            : err,
        );
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        // With no `error` listener at all, a post-bind server error is a fatal
        // uncaught exception with a stack trace. Log it and keep serving.
        server.on("error", (err) => console.error(`pome twin start: server error: ${err}`));
        resolve();
      });
    });
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
  // "Did my seed land?" is the question a user-authored seed creates, and the
  // twin cannot answer it after the fact — every seeded twin looks seeded.
  if (world.source === "file") {
    console.log(`Seed: ${world.path} (replaces the ${name} twin's default).`);
  } else if (world.source === "env") {
    console.log(
      `Seed: POME_SEED_JSON (replaces the ${name} twin's default; --seed <path> overrides it).`,
    );
  } else {
    console.log(
      `Seed: the ${name} twin's default (pass --seed <path>, or write one with \`pome twin new-seed ${name}\`).`,
    );
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
