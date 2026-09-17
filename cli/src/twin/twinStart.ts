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
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { sign } from "hono/jwt";
import { isTwinName, TWIN_NAMES, TWIN_REGISTRY, type TwinName } from "./registry.js";
import {
  parseSeedFileText,
  readSeedFileText,
  seedForTwin,
  soleTwinOf,
  twinsNamedBy,
} from "./seedFile.js";
import { bootTwin, type TwinHarness } from "./twinHarness.js";
import { resolveStandaloneSeeds } from "./twinStartSeed.js";
import { renderStateLines, resolveStandaloneDbs } from "./twinDb.js";
import { renderConnectSnippets, type ConnectSnippetInput } from "./connectSnippets.js";
import { chooseStandalonePorts } from "./twinPorts.js";
import {
  snapshotStandaloneInitialState,
  updateStandaloneStatusFile,
  type StandaloneStatus,
} from "./twinStatusFile.js";

// The status file and the port choice have their own modules; re-exported so
// `pome twin status` and the tests keep one import path for the command.
export {
  STANDALONE_STATUS_PATH,
  mergeStandaloneStatus,
  readStandaloneStatusFile,
  standaloneStatusEntries,
  updateStandaloneStatusFile,
  writeStandaloneStatusFile,
  type StandaloneStatus,
  type StandaloneStatusFile,
} from "./twinStatusFile.js";
export { chooseStandalonePorts, isLoopbackPortFree } from "./twinPorts.js";
export {
  resolveStandaloneSeed,
  resolveStandaloneSeeds,
  type StandaloneSeed,
} from "./twinStartSeed.js";

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

/**
 * Which twins `pome twin start` is starting, from its `[names...]` argument.
 *
 * One name is the everyday case and keeps `resolveStandaloneTwin`'s rules;
 * several names boot several twins in one process (F-1836). No name at all
 * still means "the one twin the `--seed` envelope names". A name repeated or
 * unknown is refused here, before any seed is parsed or any port bound.
 */
export function resolveStandaloneTwins(
  names: readonly string[],
  seedPath: string | undefined,
  seedText: string | undefined,
): TwinName[] {
  if (names.length === 0) return [resolveStandaloneTwin(undefined, seedPath, seedText)];
  const twins: TwinName[] = [];
  for (const name of names) {
    if (!isTwinName(name)) {
      throw new Error(`Unknown twin '${name}'. Supported: ${TWIN_NAMES.join(", ")}.`);
    }
    if (twins.includes(name)) {
      throw new Error(
        `pome twin start: '${name}' is named twice. Each twin boots once per command; name it once.`,
      );
    }
    twins.push(name);
  }
  return twins;
}


/**
 * One process serves one `TWIN_AUTH_SECRET` (the twins' auth middleware reads
 * the env per request), so several twins share one secret. Env still wins.
 * Otherwise the persisted files are consulted: one distinct persisted secret
 * is used for all, two different ones are a refusal naming both files rather
 * than a silent pick, and none at all means a fresh per-boot secret. One
 * twin is `resolveStandaloneAuthSecret` unchanged.
 */
export function resolveStandaloneAuthSecretFor(
  twins: readonly TwinName[],
  env: NodeJS.ProcessEnv = process.env,
  resolveOne: (twin: string, env: NodeJS.ProcessEnv) => StandaloneAuthSecret = resolveStandaloneAuthSecret,
): StandaloneAuthSecret {
  if (twins.length === 1) return resolveOne(twins[0]!, env);
  if (env.TWIN_AUTH_SECRET) return { secret: env.TWIN_AUTH_SECRET, source: "env" };
  const persisted = twins
    .map((twin) => resolveOne(twin, env))
    .filter((resolved) => resolved.source === "persisted");
  const distinct = new Set(persisted.map((resolved) => resolved.secret));
  if (distinct.size > 1) {
    throw new Error(
      `pome twin start: ${persisted.map((resolved) => resolved.path).join(" and ")} hold different secrets, ` +
        `and one process serves one secret. Inject TWIN_AUTH_SECRET, or make the files agree.`,
    );
  }
  const shared = persisted[0];
  if (shared !== undefined) return { secret: shared.secret, source: "persisted", path: shared.path! };
  return { secret: randomBytes(32).toString("hex"), source: "ephemeral" };
}


export async function runTwinStartCommand(
  namesArg: readonly string[] | string | undefined,
  options: { port?: string; seed?: string },
): Promise<void> {
  const names =
    namesArg === undefined ? [] : typeof namesArg === "string" ? [namesArg] : [...namesArg];
  // Read the seed file BEFORE resolving the twins: with no name given, the
  // file is what names the twin. One read feeds both.
  const seedText =
    options.seed === undefined
      ? undefined
      : readSeedFileText(options.seed, "pome twin start --seed");
  const twins = resolveStandaloneTwins(names, options.seed, seedText);
  // Each twin's db first: a `--seed` contradicting its `*_NO_SEED` is refused
  // before a port is probed, let alone a db file created.
  const dbs = resolveStandaloneDbs(twins, options.seed, process.env);
  const ports = await chooseStandalonePorts(twins, options.port, process.env);

  // Resolve every seed BEFORE the auth secret and any listener: a refused seed
  // must not persist a secret file or leave a bound port behind.
  const seeds = await resolveStandaloneSeeds(
    twins,
    options.seed,
    process.env,
    seedText,
    (twin) => dbs.get(twin)!.noSeed,
  );

  const resolved = resolveStandaloneAuthSecretFor(twins);
  // The in-process twins' auth middleware (resolveAuthSecret) reads the env;
  // pinning the resolved secret here is what makes the minted JWT and the
  // running twins agree.
  process.env.TWIN_AUTH_SECRET = resolved.secret;

  type Booted = { twin: TwinName; port: number; baseUrl: string; harness: TwinHarness };
  const booted: Booted[] = [];
  try {
    for (const [index, twin] of twins.entries()) {
      const port = ports[index]!;
      const baseUrl = `http://127.0.0.1:${port}`;
      const harness = await bootTwin({
        twin,
        seedState: seeds.get(twin)!.seedState,
        runId: STANDALONE_SID,
        twinBaseUrl: baseUrl,
        dbPath: dbs.get(twin)!.dbPath,
        noSeed: dbs.get(twin)!.noSeed,
      });
      booted.push({ twin, port, baseUrl, harness });
      // The boot snapshot `twin tape --diff` diffs against (F-1837); nothing listens yet.
      await snapshotStandaloneInitialState(twin, () => harness.exportState());
    }
  } catch (err) {
    for (const entry of booted) await entry.harness.close();
    throw err;
  }

  // One token for every twin in this process, the way `pome run --local` mints
  // it: `login` so the GitHub REST merge gate resolves the agent user, plus
  // every twin's extra claims (stripe's `account_id`) so the token lands on
  // each seeded account. With one twin the claims are exactly that twin's.
  let extraClaims: Record<string, unknown> = {};
  for (const entry of booted) extraClaims = { ...extraClaims, ...(entry.harness.extraClaims ?? {}) };
  const token = await sign(
    {
      sid: STANDALONE_SID,
      team_id: "tm_local",
      login: "pome-agent",
      ...extraClaims,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    resolved.secret,
  );

  const servers: ServerType[] = [];
  const closeAll = async () => {
    for (const server of servers) {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const entry of booted) await entry.harness.close();
  };
  try {
    for (const entry of booted) {
      const server = serve({ fetch: entry.harness.app.fetch, port: entry.port, hostname: "127.0.0.1" });
      servers.push(server);
      // `serve()` calls listen() and attaches no `error` listener, and listen is
      // async: without this await, an EADDRINUSE lands as an uncaught `error`
      // event AFTER the status file and the whole banner have been written, so
      // the reader gets a stack trace under a token that never worked.
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          reject(
            err.code === "EADDRINUSE"
              ? new Error(
                  `pome twin start: port ${entry.port} is already in use — pass --port <port>, or stop the twin using it.`,
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
    }
    const entries: StandaloneStatus[] = booted.map((entry) => {
      const restUrl = `${entry.baseUrl}/s/${STANDALONE_SID}`;
      return { name: entry.twin, url: restUrl, rest_url: restUrl, mcp_url: `${restUrl}/mcp`, auth_token: token };
    });
    await updateStandaloneStatusFile(entries);
  } catch (err) {
    // Boot fails loudly or not at all: without this, the rejection leaves a
    // bound listener keeping the process alive behind the error message.
    await closeAll();
    throw err;
  }

  const connect: ConnectSnippetInput[] = [];
  for (const [index, entry] of booted.entries()) {
    const { twin: name, port, baseUrl, harness } = entry;
    const restUrl = `${baseUrl}/s/${STANDALONE_SID}`;
    const mcpUrl = `${restUrl}/mcp`;
    console.log(`Pome ${name} twin listening at ${restUrl}`);
    console.log(renderStateLines(name, seeds.get(name)!, dbs.get(name)!));
    // One secret per process, so the persisted-secret line is said once.
    if (index === 0 && resolved.source === "persisted") {
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
    connect.push({
      name,
      envName: harness.envName,
      port,
      restUrl,
      mcpUrl,
      token,
      ...(harness.tokenEnvName ? { tokenEnvName: harness.tokenEnvName } : {}),
    });
  }
  // F-1827 — the URL and token above used to be the whole answer, and the
  // reader hand-wired them into their client. Print the exact text each
  // client takes instead, after the env lines so `POME_AUTH_TOKEN=` is still
  // the first token on the wire for anything that greps for it. Several twins
  // share one block: one export line, one .mcp.json, one paste.
  console.log("");
  console.log(renderConnectSnippets(connect));
  console.log("");
  console.log("Ctrl-C to stop.");

  // Foreground servers: the bound sockets keep the event loop alive until a
  // signal lands. Graceful path closes every listener, then flushes each
  // recorder and releases the SQLite handles via the harnesses.
  const shutdown = () => {
    void (async () => {
      // `close()` alone waits for in-flight keep-alive connections, so a
      // stuck client would turn Ctrl-C into a hang: sever connections first,
      // and keep an unref'd hard deadline in case a close callback never
      // resolves anyway.
      const hardExit = setTimeout(() => process.exit(1), 10_000);
      hardExit.unref();
      await closeAll();
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
