// SPDX-License-Identifier: Apache-2.0
//
// `pome twin seed <name...>` — a starter seed file, generated from the twin.
//
// THE POINT IS THAT NOBODY TYPES IT. Every hand-written seed example we shipped
// was correct the day it merged and three of the five stopped parsing against
// their own twin's schema without anything noticing (F-1691). A starter that is
// COMPUTED from `defaultSeed()` and normalised by the twin's own `parseSeed`
// cannot reach a reader in that state: if the twin's schema moves, the generated
// file moves with it, and if the twin cannot parse its own default the generator
// itself fails.
//
// Two consequences worth stating, because they are the reason this is not just
// `JSON.stringify(defaultSeed())`:
//
//   - The output is `parseSeed`'s, not the raw default. That fills every
//     defaulted field in, so the file DECLARES the world rather than implying
//     it, and it declares only fields the schema declares — which is what makes
//     it survive those schemas refusing unknown keys (F-1689).
//   - It carries no `_meta`. A generated starter is a seed file, not a compiled
//     task sidecar.
//
// The shape is always the per-twin envelope, one twin or five. Flat is still
// ACCEPTED at every door (`seedFile.ts`); it is no longer produced.

import { writeFile } from "node:fs/promises";
import { isTwinName, TWIN_NAMES, TWIN_REGISTRY, type TwinName } from "./registry.js";

/**
 * The starter seed file for `twins`, as the text to write.
 *
 * Deterministic: the same twins produce the same bytes, which is what lets a
 * docs page and a CI gate hold the generated content to equality rather than to
 * "looks about right".
 */
export async function generateSeedFile(twins: readonly TwinName[]): Promise<string> {
  if (twins.length === 0) {
    throw new Error(`No twin specified. Pass at least one of: ${TWIN_NAMES.join(", ")}.`);
  }
  for (const twin of twins) {
    if (!isTwinName(twin)) {
      throw new Error(`Unknown twin '${twin}'. Supported: ${TWIN_NAMES.join(", ")}.`);
    }
  }
  const duplicates = twins.filter((twin, i) => twins.indexOf(twin) !== i);
  if (duplicates.length > 0) {
    // An envelope is a JSON object, so a repeated twin would not produce a
    // duplicate key — it would silently produce one entry and look fine.
    throw new Error(`A seed file has one entry per twin, and this one is named twice: ${[...new Set(duplicates)].join(", ")}.`);
  }

  const envelope: Record<string, unknown> = {};
  for (const twin of twins) {
    const entry = TWIN_REGISTRY[twin];
    envelope[twin] = await entry.parseSeed(await entry.defaultSeed());
  }
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Write a generated seed file, refusing to overwrite. A file at this path is
 *  authored content the moment it exists — `emulate init` takes the same line,
 *  and the alternative is a command that silently discards a world someone
 *  edited. */
export async function writeSeedFile(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `${path} already exists — delete it or pass a different --out. ` +
          `A seed file is authored content once it is on disk.`,
      );
    }
    throw err;
  }
}

export async function runTwinSeedCommand(
  names: string[],
  options: { out?: string } = {},
): Promise<void> {
  const text = await generateSeedFile(names as TwinName[]);
  if (options.out === undefined) {
    process.stdout.write(text);
    return;
  }
  await writeSeedFile(options.out, text);
  // stderr, so `pome twin seed github --out seed.json` says what it did without
  // that line landing in a file when someone also redirects stdout.
  console.error(`Wrote ${options.out} — the ${names.join(" + ")} starting seed.`);
  console.error(`Boot it: pome twin start ${names[0]} --seed ${options.out}`);
}
