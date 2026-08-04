// SPDX-License-Identifier: Apache-2.0
/**
 * `pome checks lint <file...>` — do this task's `[code]` criteria bind to a check
 * their twin declares? (F-1134)
 *
 * `pome checks add` warns about the block it writes into, which covers an author
 * mid-edit. This covers the rest: a file already on disk, a whole directory of
 * them via a shell glob, and a builder's own CI. Before this, the only doors that
 * refused a non-binding criterion were `save_task` and `validate_task` over the
 * hosted MCP and the corpus gate in this repo's CI — so a builder authoring tasks
 * in their own repo had no way to ask the question at all, and their first signal
 * was a run whose score had quietly dropped a criterion.
 *
 * OFFLINE. Reads only the CLI's own pinned declarations, so the answer does not
 * depend on reaching the cloud — which is the point, since the gap this closes
 * lives in exactly the mode where the cloud is not there.
 */
import { readFile } from "node:fs/promises";

import { auditCodeCriteria, formatBindingReport } from "./criterion-binding.js";

function count(n: number, singular: string, plural: string): string {
  return `${n} [code] ${n === 1 ? singular : plural}`;
}

export async function runChecksLintCommand(files: string[]): Promise<void> {
  let unreadable = false;
  let failing = false;

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      // Never a silent pass: a file we could not open is the one case where
      // saying nothing would read as a clean bill.
      console.error(`Could not read ${file}.`);
      unreadable = true;
      continue;
    }

    const { bound, unanswerable, findings } = auditCodeCriteria(source);

    if (findings.length > 0) {
      console.error(formatBindingReport(findings, file));
      console.error("");
      failing = true;
      continue;
    }

    const notes = [`${count(bound, "criterion binds", "criteria bind")}`];
    if (unanswerable.length > 0) {
      const twins = [...new Set(unanswerable.map((c) => c.twin))].sort();
      notes.push(
        `${unanswerable.length} unanswerable (${twins.join(", ")} ` +
          `declare${twins.length === 1 ? "s" : ""} no checks yet)`,
      );
    }
    console.log(`✓ ${file} — ${notes.join(", ")}`);
  }

  // A file we could not read outranks a criterion that will not be graded: one is
  // "the question was not asked", the other is an answer.
  if (unreadable) process.exitCode = 2;
  else if (failing) process.exitCode = 1;
}
