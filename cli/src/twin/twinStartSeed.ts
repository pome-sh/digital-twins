// SPDX-License-Identifier: Apache-2.0
//
// Which seed each twin `pome twin start` boots — the read side of the seed
// contract, the way `twinPorts.ts` is the read side of the port one.
//
// Split out of `twinStart.ts` when the no-seed rule arrived (F-1758): the
// command module was at the file-size ceiling, and "where does this twin's
// starting state come from" is one question whether it is answered for one
// twin or five.

import { TWIN_REGISTRY, type TwinName } from "./registry.js";
import { parseSeedFileText, readSeedFileText, seedForTwin } from "./seedFile.js";

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
 *      rather than the twin's own `loadSeedFromEnv`. Skipped under `noSeed`,
 *      which CONTRACT.md gives precedence over it.
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
  noSeed = false,
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

  // CONTRACT.md: a twin's `*_NO_SEED` takes precedence over `POME_SEED_JSON`.
  // So an ambient seed this boot will never apply must not refuse it either —
  // a stale or schema-invalid envelope left in the shell would otherwise stop
  // a twin from serving the db it was told to serve. `--seed` is not in this
  // branch: typed at the command against a `*_NO_SEED`, it is refused outright
  // by `resolveStandaloneDb`.
  const fromEnv = noSeed ? undefined : env.POME_SEED_JSON;
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
 * The seed each twin boots, keyed by twin. One twin is `resolveStandaloneSeed`
 * unchanged. Several twins read the same authored source once (`--seed`, else
 * `POME_SEED_JSON`, else every twin's default) and apply the single-twin rules
 * per twin: a flat file cannot say which of several twins it is for, so it is
 * refused naming the mismatch, and an envelope must carry every named twin —
 * the same loud refusal one twin gets when the envelope has no entry for it.
 * Extra twins the envelope names are tolerated, as they are for one twin.
 */
export async function resolveStandaloneSeeds(
  twins: readonly TwinName[],
  seedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  seedText?: string,
  noSeed: (twin: TwinName) => boolean = () => false,
): Promise<Map<TwinName, StandaloneSeed>> {
  const out = new Map<TwinName, StandaloneSeed>();
  if (twins.length === 1) {
    const only = twins[0]!;
    out.set(only, await resolveStandaloneSeed(only, seedPath, env, seedText, noSeed(only)));
    return out;
  }
  // A no-seed twin takes its default and asks nothing of the authored source:
  // it applies none of it, so it must not be what refuses the envelope for
  // naming only the twins that will use one.
  for (const twin of twins.filter(noSeed)) {
    out.set(twin, { seedState: await TWIN_REGISTRY[twin].defaultSeed(), source: "default" });
  }
  const seeded = twins.filter((twin) => !noSeed(twin));
  if (seeded.length === 0) return out;

  let authored: { raw: string; origin: string; source: "file" | "env"; path?: string } | undefined;
  if (seedPath !== undefined) {
    authored = {
      raw: seedText ?? readSeedFileText(seedPath, "pome twin start --seed"),
      origin: `--seed ${seedPath}`,
      source: "file",
      path: seedPath,
    };
  } else if (env.POME_SEED_JSON !== undefined && env.POME_SEED_JSON !== "") {
    authored = { raw: env.POME_SEED_JSON, origin: "POME_SEED_JSON", source: "env" };
  }

  if (authored === undefined) {
    for (const twin of seeded) {
      out.set(twin, { seedState: await TWIN_REGISTRY[twin].defaultSeed(), source: "default" });
    }
    return out;
  }

  const file = parseSeedFileText(authored.raw, authored.origin);
  if (file.shape === "flat") {
    throw new Error(
      `${authored.origin} is a flat seed for one twin, and pome twin start was given ${twins.length} names ` +
        `(${twins.join(", ")}), so nothing says which one it is for. Name one twin, or wrap it in a ` +
        `per-twin envelope: { "${twins[0]}": { … } }.`,
    );
  }
  for (const twin of seeded) {
    out.set(twin, {
      seedState: await seedForTwin(file, twin, authored.origin),
      source: authored.source,
      ...(authored.path !== undefined ? { path: authored.path } : {}),
    });
  }
  return out;
}
