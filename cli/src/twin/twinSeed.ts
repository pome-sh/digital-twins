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
// TWO DESTINATIONS, ONE RULE EACH — and `--for-task` picks the destination, not
// the shape.
//
//   a DOOR file (`twin start --seed`, `sandbox create --seed`) is always the
//   per-twin envelope, one twin or five. It is handed around on its own, so it
//   has to say which twin it is for, and it must not change shape the moment its
//   author adds a second twin ([DECISION] on F-1685, 2026-08-26).
//
//   a SIDECAR (`<task>.seed.json`) is flat for one twin and the envelope for
//   more, because the `<task>.md` beside it already names its twins in
//   `## Config`. That is `parseTask`'s rule since 2026-05-12 and this does not
//   change it — `--for-task` just emits what that rule asks for.
//
// So the two outputs are identical from two twins up, and `twinSeedForTask.test.ts`
// asserts that convergence so `--for-task` cannot drift into a second format.
//
// The sidecar half closes a real hole: `pome compile-seeds` emits one only for a
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
export async function generateSeedFile(
  twins: readonly TwinName[],
  opts: { forTask?: boolean } = {},
): Promise<string> {
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
  // The one place the two destinations differ. Everywhere else — two twins or
  // five, door or sidecar — the bytes are the same.
  const body = opts.forTask && twins.length === 1 ? envelope[twins[0]!] : envelope;
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
  options: { out?: string; forTask?: boolean } = {},
): Promise<void> {
  const text = await generateSeedFile(names as TwinName[], { forTask: options.forTask });
  if (options.out === undefined) {
    process.stdout.write(text);
    return;
  }
  await writeSeedFile(options.out, text);
  // stderr, so `pome twin seed github --out seed.json` says what it did without
  // that line landing in a file when someone also redirects stdout.
  const what = options.forTask ? "task seed" : "starting seed";
  console.error(`Wrote ${options.out} — the ${names.join(" + ")} ${what}.`);
  console.error(
    options.forTask
      ? `Put it next to a task whose \`## Config\` reads twins: [${names.join(", ")}], named <task>.seed.json.`
      : `Boot it: pome twin start ${names[0]} --seed ${options.out}`,
  );
}
