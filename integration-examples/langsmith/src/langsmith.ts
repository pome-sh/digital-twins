// SPDX-License-Identifier: Apache-2.0
//
// The framework half: everything that knows LangSmith exists.
//
// `src/pome.ts` is the sibling example's file, copied. This one has no sibling: it
// is what a second eval platform actually costs.
//
// The HANDOFF is a few lines — a target that returns a dict, an evaluator that
// reads it. What makes this file four times that size is the three things
// Braintrust supplies for free and LangSmith does not: a dataset that has to
// exist before `evaluate()` will run, an account it will not run without, and a
// summary nothing prints. Each has its own section below, and the fourth is a
// concurrency cap whose near-miss is silent.
//
// ── 1. `evaluate()` reads its rows out of LangSmith, not out of your array ───
//
// Braintrust's `Eval()` takes the dataset in memory. LangSmith's `evaluate()`
// takes `data: string | AsyncIterable<Example> | Example[]`, and every one of
// those paths ends at a real dataset: passing `Example[]` still requires each
// example to carry a `dataset_id`, because the experiment is created with
// `referenceDatasetId: firstExample.dataset_id`. So a dataset has to exist, and
// the durable copy of the row set lives on their side. `datasetName` and
// `ensureDataset` are what keep that copy honest.
//
// ── 2. There is no `noSendLogs` ─────────────────────────────────────────────
//
// `evaluate()` calls `client.createProject()` inside its `start()`, BEFORE the
// first prediction, so there is no local-only run and no way to watch this demo
// work without an account. That is worth one named sentence rather than a bare
// 401 — see `requireLangSmithKey`. The upside of the ordering: a missing
// LangSmith key costs nothing, because it fails before any sandbox is minted.
//
// ── 3. Nothing prints the verdicts ──────────────────────────────────────────
//
// `evaluate()` logs the experiment name and a compare URL and that is all, so a
// reader with no browser open sees none of what this example is about.
// `summarizeFeedback` is the terminal's copy of the experiment table.
//
// ── 4. The cap is `maxConcurrency`, and the near-miss is silent ─────────────
//
// See `evalOptions` in `src/index.ts`: `targetConcurrency` alone does NOT bound
// anything, and 0 means unbounded rather than none.

import { createHash } from "node:crypto";

import type { DatasetRow } from "./dataset.js";
import { rowIdFor } from "./dataset.js";

/** The dataset's name, before the row-set digest is appended. */
export const DATASET_BASE_NAME = "pome-lost-response-double-refund";

/**
 * The dataset name for one row set.
 *
 * THE STALE-DATASET CASE. Because `evaluate()` reads its examples out of
 * LangSmith and not out of `DATASET`, a reader who edits the row set and re-runs
 * would otherwise be served the OLD rows under the same name — and shown a
 * summary of the right shape and the wrong content, which is the failure mode
 * this repository spends most of its comments on. The digest makes a changed row
 * set a different dataset, so the two cannot be confused. It is over the row IDS
 * and sorted, because the row set is a set: reordering `WORLDS` is not a change
 * and should not fork a dataset.
 *
 * The worlds and their seeds are NOT in the digest, on purpose — they never
 * travel to LangSmith at all, so they cannot go stale there. `resolveRow` binds
 * them from this checkout on every run.
 */
export function datasetName(rows: DatasetRow[], base = DATASET_BASE_NAME): string {
  const ids = rows.map((row) => rowIdFor(row.inputs)).sort();
  const digest = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

/** One row, addressed to a dataset. LangSmith's `ExampleCreate`, narrowed to the
 *  fields this example sends. */
export interface ExampleUpload {
  dataset_id: string;
  inputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * The bit of `langsmith`'s `Client` this module needs.
 *
 * Structural, so `test/langsmith.test.ts` can hand it a stub and stay hermetic —
 * no network, no key, no recorded cassette. `Client` satisfies it as-is; the
 * narrow shape is also the shortest statement of how small the LangSmith API
 * surface of this recipe actually is.
 */
export interface DatasetStore {
  hasDataset(params: { datasetName: string }): Promise<boolean>;
  readDataset(params: { datasetName: string }): Promise<{ id: string }>;
  createDataset(name: string, options?: { description?: string }): Promise<{ id: string }>;
  listExamples(params: { datasetName: string }): AsyncIterable<{ inputs: Record<string, unknown> }>;
  createExamples(uploads: ExampleUpload[]): Promise<unknown>;
}

/**
 * Which rows LangSmith does not hold yet.
 *
 * Once the name carries the row-set digest, a dataset with the right name and the
 * wrong rows can only come from an upload that was interrupted — and a reader
 * pressing Ctrl-C during the first run is not a hypothetical. Left unhandled it
 * is permanent: the name matches, so the short dataset is reused every run
 * afterwards and the missing rows are simply never evaluated.
 */
export function missingUploads(
  existing: ReadonlyArray<{ inputs: Record<string, unknown> }>,
  rows: DatasetRow[],
  datasetId: string,
): ExampleUpload[] {
  const held = new Set(
    existing.map((example) =>
      rowIdFor({
        world: String(example.inputs.world),
        policy: example.inputs.policy as DatasetRow["inputs"]["policy"],
      }),
    ),
  );
  return rows
    .filter((row) => !held.has(rowIdFor(row.inputs)))
    .map((row) => ({ dataset_id: datasetId, inputs: { ...row.inputs }, metadata: { ...row.metadata } }));
}

/** Create the dataset if it is not there, and top it up if it is short. */
export async function ensureDataset(input: {
  client: DatasetStore;
  name: string;
  rows: DatasetRow[];
  description?: string;
}): Promise<{ datasetId: string; created: boolean; uploaded: number }> {
  const exists = await input.client.hasDataset({ datasetName: input.name });

  if (!exists) {
    const dataset = await input.client.createDataset(input.name, {
      description:
        input.description ??
        "Generated by integration-examples/langsmith. One row per (world x retry policy); " +
          "each row's world is seeded into its own Pome sandbox at run time.",
    });
    const uploads = missingUploads([], input.rows, dataset.id);
    await input.client.createExamples(uploads);
    return { datasetId: dataset.id, created: true, uploaded: uploads.length };
  }

  const dataset = await input.client.readDataset({ datasetName: input.name });
  const existing: Array<{ inputs: Record<string, unknown> }> = [];
  for await (const example of input.client.listExamples({ datasetName: input.name })) {
    existing.push(example);
  }
  const uploads = missingUploads(existing, input.rows, dataset.id);
  if (uploads.length > 0) await input.client.createExamples(uploads);
  return { datasetId: dataset.id, created: false, uploaded: uploads.length };
}

/**
 * One sentence for the credential `evaluate()` cannot run without.
 *
 * Both names are accepted because the SDK accepts both:
 * `getLangSmithEnvironmentVariable("API_KEY")` reads
 * `LANGSMITH_API_KEY || LANGCHAIN_API_KEY`, so an environment carrying only the
 * legacy name is one the SDK works in, and refusing it would refuse a working
 * setup.
 *
 * Returns the message rather than throwing so the caller decides WHEN — this
 * must not run before the example's first outbound call, or
 * `scripts/smoke-examples.mjs` sees a process that exited without reaching one
 * and cannot tell that apart from a broken example.
 */
export function requireLangSmithKey(env: Record<string, string | undefined>): string | null {
  if (env.LANGSMITH_API_KEY?.trim() || env.LANGCHAIN_API_KEY?.trim()) return null;
  return (
    "LANGSMITH_API_KEY is not set. Unlike Braintrust's Eval(), LangSmith's evaluate() has no " +
    "local-only mode — it creates the experiment (client.createProject) before the first row runs — " +
    "so this example needs a LangSmith key. The Developer tier is $0 for 1 seat: get a key at " +
    "https://smith.langchain.com/settings. (LANGCHAIN_API_KEY, the legacy name, works too.) " +
    "Nothing has been provisioned and no sandbox was minted."
  );
}

/** One row of whatever `evaluate()` handed back, narrowed to what a summary and
 *  an exit code need. `ExperimentResultRow` satisfies it. */
export interface FeedbackRow {
  run?: { error?: string | null };
  evaluationResults?: { results?: ReadonlyArray<{ key?: string; score?: unknown; value?: unknown }> };
}

export interface NumericSummary {
  key: string;
  kind: "numeric";
  /** Mean over the rows that answered. */
  mean: number;
  counted: number;
  /** Rows whose answer was `null` — "we did not find out", left out of the mean
   *  exactly as LangSmith leaves it out of the aggregate. */
  unanswered: number;
}

export interface CategoricalSummary {
  key: string;
  kind: "categorical";
  values: Record<string, number>;
}

export type FeedbackSummary = NumericSummary | CategoricalSummary;

/**
 * The experiment table, for the terminal.
 *
 * `evaluate()` prints the experiment name and a compare URL and nothing else, so
 * without this the one thing this example is about — which criterion went red on
 * which row — is only visible to a reader who opens a browser.
 *
 * Keys are reported in first-seen order so the numeric criteria stay in the order
 * the task declares them rather than alphabetically.
 */
export function summarizeFeedback(rows: readonly FeedbackRow[]): FeedbackSummary[] {
  const numeric = new Map<string, { total: number; counted: number; unanswered: number }>();
  const categorical = new Map<string, Record<string, number>>();
  const order: string[] = [];

  for (const row of rows) {
    for (const entry of row.evaluationResults?.results ?? []) {
      const key = entry.key;
      if (!key) continue;
      if (!order.includes(key)) order.push(key);
      if (typeof entry.value === "string") {
        const tally = categorical.get(key) ?? {};
        tally[entry.value] = (tally[entry.value] ?? 0) + 1;
        categorical.set(key, tally);
        continue;
      }
      const bucket = numeric.get(key) ?? { total: 0, counted: 0, unanswered: 0 };
      if (typeof entry.score === "number") {
        bucket.total += entry.score;
        bucket.counted += 1;
      } else if (typeof entry.score === "boolean") {
        bucket.total += entry.score ? 1 : 0;
        bucket.counted += 1;
      } else {
        bucket.unanswered += 1;
      }
      numeric.set(key, bucket);
    }
  }

  return order.map((key) => {
    const tally = categorical.get(key);
    if (tally) return { key, kind: "categorical" as const, values: tally };
    const bucket = numeric.get(key)!;
    return {
      key,
      kind: "numeric" as const,
      mean: bucket.counted === 0 ? 0 : bucket.total / bucket.counted,
      counted: bucket.counted,
      unanswered: bucket.unanswered,
    };
  });
}
