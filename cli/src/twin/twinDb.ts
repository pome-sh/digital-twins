// SPDX-License-Identifier: Apache-2.0
//
// Where a twin `pome twin start` boots keeps its state, whether the seed is
// applied to it, and what the banner says about both.
//
// CONTRACT.md gives every twin two variables for this — `*_DB`, the SQLite
// path, and `*_NO_SEED=1`, leave what is in it alone — and until F-1758 this
// command read neither. It boots in process through `bootTwin`, not through
// the twin's own `src/server.ts`, and four of the five registry entries
// passed the literal `":memory:"`. So `STRIPE_CLONE_DB` meant something in the
// container and nothing at the front door: a reader who set it, wrote rows
// through their agent and restarted silently got the seed back. Same two
// variables, same names, resolved here, so a path that persists state in the
// container persists it here.
//
// Both halves are needed for that sentence to be true. A path alone still
// re-seeds on the next boot, and every twin's `seed()` resets its tables
// first — which is why `*_NO_SEED` is not a separate feature but the other
// half of a file db.

import { TWIN_REGISTRY, type TwinName } from "./registry.js";

/** Where one standalone twin's state lives, and whether it re-seeds. */
export type StandaloneDb = {
  /** What the twin opens: a file path, or `":memory:"`. */
  dbPath: string;
  /** Serve the db as it stands — apply no seed at boot. */
  noSeed: boolean;
  /** The twin's own path variable, named in the banner and in errors. */
  dbEnvName: string;
  /** The twin's own no-seed variable, named in the banner and in errors. */
  noSeedEnvName: string;
};

/**
 * Read side of the persistence contract, mirroring `resolveStandaloneSeed`:
 * the twin's own `*_DB` names the file, else `":memory:"`, and its own
 * `*_NO_SEED=1` decides whether the seed is applied to it.
 *
 * `--seed <path>` together with `*_NO_SEED=1` is refused, naming both: one
 * says apply this seed, the other says apply none, and picking a winner
 * silently would leave the reader's file either clobbered or not, with the
 * banner the only clue. `POME_SEED_JSON` is different and is NOT refused —
 * CONTRACT.md already rules that a no-seed variable takes precedence over it,
 * and that is ambient environment rather than something typed at this command.
 */
export function resolveStandaloneDb(
  twin: TwinName,
  seedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StandaloneDb {
  const { dbEnvName, noSeedEnvName } = TWIN_REGISTRY[twin];
  // `=== "1"` exactly, the way the twin's own entry reads it.
  const noSeed = env[noSeedEnvName] === "1";
  if (noSeed && seedPath !== undefined) {
    throw new Error(
      `pome twin start: --seed ${seedPath} and ${noSeedEnvName}=1 contradict each other — ` +
        `one says apply this seed, the other says apply none. Drop one.`,
    );
  }
  return {
    dbPath: env[dbEnvName] || ":memory:",
    noSeed,
    dbEnvName,
    noSeedEnvName,
  };
}

/** One `StandaloneDb` per twin this command is starting. Each twin carries its
 *  own pair of variables, so several twins in one process can differ. */
export function resolveStandaloneDbs(
  twins: readonly TwinName[],
  seedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Map<TwinName, StandaloneDb> {
  return new Map(twins.map((twin) => [twin, resolveStandaloneDb(twin, seedPath, env)]));
}

/**
 * The banner's two lines about this twin's world: where the seed came from,
 * and where the rows it made will be after Ctrl-C.
 *
 * "Did my seed land?" is the question a user-authored seed creates, and the
 * twin cannot answer it after the fact — every seeded twin looks seeded. "Will
 * my rows still be here?" is the same question one boot later, and the answer
 * used to be "no" for four of the five twins however the env was set.
 *
 * Structurally typed on the seed so this module does not import the command it
 * prints for.
 */
export function renderStateLines(
  twin: TwinName,
  seed: { source: "file" | "env" | "default"; path?: string },
  db: StandaloneDb,
): string {
  const inMemory = db.dbPath === ":memory:";
  const seedLine = db.noSeed
    ? `Seed: not applied (${db.noSeedEnvName}=1).`
    : seed.source === "file"
      ? `Seed: ${seed.path} (replaces the ${twin} twin's default).`
      : seed.source === "env"
        ? `Seed: POME_SEED_JSON (replaces the ${twin} twin's default; --seed <path> overrides it).`
        : `Seed: the ${twin} twin's default (pass --seed <path>, or write one with \`pome twin new-seed ${twin}\`).`;
  const stateLine = db.noSeed
    ? inMemory
      ? `State: in memory and unseeded, so this twin starts empty — point ${db.dbEnvName} at a saved db to serve one.`
      : `State: ${db.dbPath} (${db.dbEnvName}), served as it stands.`
    : inMemory
      ? `State: in memory — nothing survives Ctrl-C (set ${db.dbEnvName}=<path> to keep it).`
      : `State: ${db.dbPath} (${db.dbEnvName}), re-seeded on every boot — ${db.noSeedEnvName}=1 keeps what is there.`;
  return `${seedLine}\n${stateLine}`;
}
