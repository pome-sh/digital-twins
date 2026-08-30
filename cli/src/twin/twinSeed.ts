// SPDX-License-Identifier: Apache-2.0
//
// `pome twin new-seed <name...>` — a starter seed file, generated from the twin.
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
// ONE SHAPE PER TWIN COUNT, AND EVERY DOOR TAKES IT: flat for exactly one twin,
// the per-twin envelope `{ <twin>: <flat seed> }` for two or more. That is
// `parseTask`'s rule for a `<task>.seed.json` sidecar since 2026-05-12, and
// `seedFile.ts` — the one door `twin start --seed` and `sandbox create --seed`
// both read — accepts both shapes. So the generated file needs no destination
// flag: it works at all three, unchanged.
//
// The cost is that a flat file names no twin, so a single-twin seed needs the
// name at two of the three doors: the `<name>` argument on `twin start`, and
// `--twin` on `sandbox create`. That is `seedFile.ts`'s standing rule for every
// flat seed, not something this generator introduces — the stderr hint below
// spells both commands out with the name already in them.
//
// This also closes a real hole: `pome compile-seeds` emits a sidecar only for a
// single-twin GITHUB task, so slack, stripe, gmail and linear task seeds have
// always been hand-written — the same standing invitation to drift that left
// three documented examples unable to boot.

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
  // Flat for one, envelope for several. One twin's seed needs no key to say
  // which twin it is: everything that reads it was already told, by the `<name>`
  // argument on `twin start`, by `--twin` on `sandbox create`, or by `## Config`
  // in the task beside the sidecar.
  const body = twins.length === 1 ? envelope[twins[0]!] : envelope;
  return `${JSON.stringify(body, null, 2)}\n`;
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
  // stderr, so `pome twin new-seed github --out seed.json` says what it did without
  // that line landing in a file when someone also redirects stdout.
  console.error(`Wrote ${options.out} — the ${names.join(" + ")} starting seed.`);
  // All three doors, because this is the one place a reminder lands for free —
  // and both commands carry the twin name, which a flat single-twin file does not.
  // `twin start` boots one twin, so it names one even when the file covers five.
  console.error(
    `Boot ${names.length === 1 ? "it" : "one"} locally: pome twin start ${names[0]} --seed ${options.out}`,
  );
  console.error(
    `Hosted: pome sandbox create ${names.map((twin) => `--twin ${twin}`).join(" ")} --seed ${options.out}`,
  );
  console.error(
    names.length === 1
      ? `As a task seed: drop it beside a ${names[0]} task as <task>.seed.json.`
      : `As a task seed: drop it beside a task whose \`## Config\` reads twins: [${names.join(", ")}], named <task>.seed.json.`,
  );
}
