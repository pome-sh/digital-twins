// SPDX-License-Identifier: Apache-2.0
//
// The one seed-file door. Every command that takes a user-authored world reads
// it through here: `pome twin start --seed`, `pome sandbox create --seed`, and
// `pome twin seed`'s own round-trip check.
//
// A seed file is JSON or YAML (JSON is a YAML subset, so one parser) in one of
// two shapes:
//
//   flat      { "repositories": [ … ] }              one twin's seed
//   envelope  { "github": { "repositories": [ … ] }} twin id → that twin's seed
//
// The envelope is the shape to write and the shape `pome twin seed` generates.
// Flat is kept because F-1686 shipped it and eight of the twenty
// `<task>.seed.json` files in agent-examples/ are one; the other twelve are
// already envelopes, and before this module `twin start github --seed <one of
// those>` failed on `repositories: expected array, received undefined`.
//
// THE SHAPE IS DECIDED FROM THE KEYS, AND ONLY THE KEYS: a file is an envelope
// iff every top-level key is a twin id. That is safe because no twin's seed
// schema declares a top-level field named after a twin, which is not an
// assumption — `seedFields()` derives the field names from each twin's own zod
// object and `seedFile.test.ts` asserts the disjointness for all five. A file
// that mixes the two vocabularies is refused rather than guessed at.
//
// WHY THIS IS NOT A SECOND SEED PARSER: it decides which BYTES belong to which
// twin and nothing else. The twin's own `parseSeed`, reached through
// `TWIN_REGISTRY[twin]`, is still the only thing that says whether a seed is
// valid — the same function the twin runs inside `loadSeedFromEnv`, so a seed
// this accepts is a seed the twin boots.
//
// SILENCE IS THE FAILURE MODE THIS EXISTS TO PREVENT. slack's and stripe's seed
// schemas WERE non-strict, so before the envelope was declared they ACCEPTED a
// `{github, slack}` file as their own flat seed, defaulted every field, and
// served an empty workspace while the boot line said the seed had landed. A file
// naming a twin the command was not asked for is a loud error here, never a
// skipped key. The schemas underneath refuse an unrecognised key of their own
// now (F-1689), which makes the two halves agree rather than making this one
// redundant: `{github, slack}` handed to slack is still a shape question, and
// this module is the only thing that asks it.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { isTwinName, TWIN_NAMES, TWIN_REGISTRY, type TwinName } from "./registry.js";

/** A seed file after `_meta` is dropped and its shape is decided. */
export type SeedFile =
  | { shape: "flat"; seed: unknown }
  | { shape: "envelope"; byTwin: Record<string, unknown> };

/** Read side of `--seed <path>`. Split from parsing so a caller that needs the
 *  twin BEFORE it has one (`twin start` with the name omitted) reads the file
 *  exactly once. */
export function readSeedFileText(path: string, flag = "--seed"): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`${flag}: cannot read ${path}: ${(err as Error).message}`);
  }
}

export function parseSeedFileText(raw: string, origin: string): SeedFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`${origin} is not valid JSON or YAML: ${(err as Error).message}`);
  }
  if (Array.isArray(parsed)) {
    throw new Error(`${origin} is not a seed file: its top level is an array, not an object.`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `${origin} is not a seed file: its top level is ${parsed === null ? "null" : typeof parsed}, not an object.`,
    );
  }

  // Drop the sidecar provenance block, so a compiled `<task>.seed.json` is a
  // seed file this door accepts as-is. Still DECLARED here even though every
  // twin's `parseSeed` now drops its own (F-1689): the shape rule below reads
  // the top-level KEYS, and a `_meta` sitting beside `github` would make an
  // envelope look like a file that mixes twin ids with other keys. So this strip
  // is what decides the shape; the twin's is what survives strictness, including
  // for the block twelve envelope sidecars carry INSIDE the twin's own arm,
  // where nothing at this level can reach it.
  const { _meta, ...rest } = parsed as Record<string, unknown>;
  void _meta;

  const keys = Object.keys(rest);
  const twinKeys = keys.filter((key) => isTwinName(key));
  if (twinKeys.length === 0) return { shape: "flat", seed: rest };
  if (twinKeys.length !== keys.length) {
    const others = keys.filter((key) => !isTwinName(key));
    throw new Error(
      `${origin} mixes twin ids (${twinKeys.join(", ")}) with other keys (${others.join(", ")}). ` +
        `A seed file is either one twin's flat seed or a per-twin envelope { <twin>: <seed> }, not both.`,
    );
  }
  return { shape: "envelope", byTwin: rest };
}

/** The twins an envelope names, in file order. Empty for a flat file: a flat
 *  seed names no twin, which is why `--twin` stays required for one. */
export function twinsNamedBy(file: SeedFile): TwinName[] {
  if (file.shape === "flat") return [];
  return Object.keys(file.byTwin).filter((key): key is TwinName => isTwinName(key));
}

/** The single twin an envelope names, when it names exactly one — the case that
 *  makes `--twin` / the `<name>` argument unnecessary. */
export function soleTwinOf(file: SeedFile): TwinName | undefined {
  const named = twinsNamedBy(file);
  return named.length === 1 ? named[0] : undefined;
}

/** The top-level field names this twin's seed schema declares. Derived from the
 *  twin's own zod object, never typed here. Two callers: the "your keys are not
 *  seed fields" hint below, and the standing assertion that no twin field is
 *  named after a twin — the property the shape rule rests on. */
export async function seedFieldsFor(twin: TwinName): Promise<readonly string[]> {
  return TWIN_REGISTRY[twin].seedFields();
}

/**
 * The seed for one twin, parsed by that twin's own `parseSeed`.
 *
 * Flat: the whole file is that twin's seed. Envelope: the entry under its id —
 * and a missing entry is an error, not a default, because the command was
 * pointed at a file that turns out to say nothing about the twin it is booting.
 *
 * `asked` is the twin list the command was invoked for. Any twin the file names
 * outside it is refused BY NAME.
 */
export async function seedForTwin(
  file: SeedFile,
  twin: TwinName,
  origin: string,
  opts: { asked?: readonly string[] } = {},
): Promise<unknown> {
  if (file.shape === "flat") return parseWith(twin, file.seed, origin, file);

  assertOnlyAsked(file, opts.asked, origin);
  const named = twinsNamedBy(file);
  if (!(twin in file.byTwin)) {
    throw new Error(
      `${origin} declares no ${twin} seed (it names ${named.join(", ")}). ` +
        `Add a "${twin}" key, or start the twin it names.`,
    );
  }
  return parseWith(twin, file.byTwin[twin], `${origin} ("${twin}")`, file);
}

/**
 * Every seed the file declares, restricted to `twins` and keyed by twin id.
 *
 * A twin in `twins` with no entry is ABSENT from the result rather than
 * defaulted here — the receiving side applies its own default, which is the
 * rule `parseTask`'s multi-twin envelope already follows. A twin the file names
 * that is NOT in `twins` is a loud error.
 */
export async function seedsForTwins(
  file: SeedFile,
  twins: readonly TwinName[],
  origin: string,
): Promise<Record<string, unknown>> {
  if (file.shape === "flat") {
    if (twins.length !== 1) {
      throw new Error(
        `${origin} is a flat seed and this sandbox has ${twins.length} twins ` +
          `(${twins.join(", ")}), so nothing says which one it is for. ` +
          `Wrap it in a per-twin envelope: { "${twins[0] ?? "<twin>"}": { … } }.`,
      );
    }
    return { [twins[0]!]: await parseWith(twins[0]!, file.seed, origin, file) };
  }

  assertOnlyAsked(file, twins, origin);
  const out: Record<string, unknown> = {};
  for (const twin of twins) {
    if (twin in file.byTwin) {
      out[twin] = await parseWith(twin, file.byTwin[twin], `${origin} ("${twin}")`, file);
    }
  }
  return out;
}

function assertOnlyAsked(
  file: SeedFile,
  asked: readonly string[] | undefined,
  origin: string,
): void {
  if (asked === undefined || file.shape !== "envelope") return;
  const extras = twinsNamedBy(file).filter((twin) => !asked.includes(twin));
  if (extras.length === 0) return;
  // Emulate's `if (!owner) continue;` is the anti-pattern here: it drops a
  // correctly-spelled repository over an undeclared owner and says nothing.
  throw new Error(
    `${origin} names ${extras.join(", ")}, which this command was not asked for ` +
      `(asked: ${asked.length ? asked.join(", ") : "none"}). ` +
      `Add --twin for each, or remove them from the file.`,
  );
}

async function parseWith(
  twin: TwinName,
  seed: unknown,
  where: string,
  file: SeedFile,
): Promise<unknown> {
  try {
    return await TWIN_REGISTRY[twin].parseSeed(seed);
  } catch (err) {
    const hint = file.shape === "flat" ? await notSeedFieldsHint(twin, file.seed) : "";
    throw new Error(`${where} is not a seed this twin can boot: ${(err as Error).message}${hint}`);
  }
}

/** A flat file whose keys are none of the twin's seed fields is usually an
 *  envelope with a misspelled or unsupported twin id, and the zod error alone
 *  ("primaryMailbox: expected object, received undefined") sends the reader
 *  looking for the wrong mistake. */
async function notSeedFieldsHint(twin: TwinName, seed: unknown): Promise<string> {
  if (seed === null || typeof seed !== "object" || Array.isArray(seed)) return "";
  const keys = Object.keys(seed as Record<string, unknown>);
  if (keys.length === 0) return "";
  const fields = new Set(await seedFieldsFor(twin));
  if (keys.some((key) => fields.has(key))) return "";
  return (
    `\n  None of its top-level keys (${keys.join(", ")}) is a field of the ${twin} seed. ` +
    `If this file is a per-twin envelope, its keys must be twin ids: ${TWIN_NAMES.join(", ")}.`
  );
}
