// SPDX-License-Identifier: Apache-2.0
//
// LangSmith `evaluate()`, where every dataset row gets its own world.
//
// ── What this example is ────────────────────────────────────────────────────
//
// LangSmith runs the eval. Pome is what the agent CALLS during it: a recorded,
// seeded digital twin of the SaaS APIs the agent hits in production. LangSmith
// also sells something called a sandbox and it is not the same thing — theirs is
// an ephemeral container for running agent-GENERATED code; Pome's is a
// Stripe-shaped digital twin your agent TALKS TO, which remembers every request
// it received.
//
// One dataset row → one `POST /v1/sandboxes` → one isolated Stripe world seeded
// from that row → a real agent driving it → `POST /v1/sandboxes/:id/finalize`.
// Every Pome criterion comes back as its own LangSmith feedback key.
//
// This is the second framework over the same recipe.
// `integration-examples/braintrust` runs these same six worlds through the same
// four Pome calls; `src/pome.ts` is that example's file, copied, and
// `src/langsmith.ts` is everything that knows LangSmith exists.
//
// ── What it demonstrates, and why this failure ──────────────────────────────
//
// Both `POST /v1/refunds` calls are individually well-formed and correctly
// argued, and retrying after a 500 is textbook trajectory behaviour. The
// trajectory is clean. The money is wrong.
//
// That is trace versus tape. A LangSmith run is the client's record of what the
// agent meant to do; the tape is the twin's record of what it actually received.
// An agent can produce a perfect run for a call that never happened; it cannot
// produce a refund row.
//
// ── The evaluator is NOT network-blocked, and that is worth stating ──────────
//
// LangSmith's "you cannot access the internet from a code evaluator" applies to
// their ONLINE, UI-defined code evaluators — the ones that run in LangSmith's
// cloud on stdlib plus numpy, pandas, jsonschema, scipy and scikit-learn. An SDK
// evaluator passed to `evaluate()`, like the one below, runs in this process and
// can call anything. So there is no workaround here: the evidence travels through
// the target's returned dict because that is cleaner, not because it has to.
// (Verified against LangSmith's docs 2026-08-27.)

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import type { EvaluationResult, EvaluatorT, TargetT } from "langsmith/evaluation";

import { runAgent } from "./agent.js";
import { DATASET, WORLDS, resolveRow, rowIdFor, seedFor } from "./dataset.js";
import type { DatasetRowInputs } from "./dataset.js";
import {
  datasetName,
  ensureDataset,
  requireLangSmithKey,
  summarizeFeedback,
} from "./langsmith.js";
import type { FeedbackRow, FeedbackSummary } from "./langsmith.js";
import { assertWorldSeeded, readCharge, validateSeed, withPomeSandbox } from "./pome.js";
import type { Env, PomeRunEvidence } from "./pome.js";
import { criteriaFor, renderTask } from "./task.js";

/** What the target hands the evaluator. A LangSmith evaluator sees `inputs`,
 *  `outputs`, `referenceOutputs`, `run` and `example` — and nothing else the
 *  target produced — so the Pome evidence has to travel inside the OUTPUTS.
 *  LangSmith's target returns a dict natively, which is why `{answer, pome}` is
 *  the whole handoff and no scalar needs wrapping. */
export interface RefundTaskOutput {
  /** The agent's own last word. */
  answer: string;
  pome: PomeRunEvidence;
}

/** One dataset row: one sandbox, one world, one agent, one graded run. */
export async function runRow(
  inputs: DatasetRowInputs,
  env: Env,
  groupId: string,
): Promise<RefundTaskOutput> {
  // Bound to THIS checkout, loudly. The rows live in LangSmith's dataset store
  // and the worlds live in `src/dataset.ts`, so the two can drift apart.
  const { world, policy } = resolveRow(inputs);
  const task = renderTask(world);

  const { summary, pome } = await withPomeSandbox({
    env,
    twins: ["stripe"],
    taskMarkdown: task,
    seed: seedFor(world),
    groupId,
    criteria: criteriaFor(world),
    taskName: `${world.situationTitle} · ${policy.id}`,
    prompt: world.situation,
    expectedBehavior: `Exactly one refund of ${world.refundMinorUnits} exists on ${world.chargeId}.`,
    // The seed is checked twice and this is the half that matters: the Stripe
    // twin's seed schema is not strict, so a dropped key boots an EMPTY world
    // and every criterion grades `skipped` — a row of blank cells, not a red.
    assertWorld: async (sandbox) => {
      assertWorldSeeded(world, await readCharge(sandbox, world.chargeId));
    },
    drive: async (sandbox) => {
      const run = await runAgent({
        apiUrl: sandbox.apiUrl,
        agentToken: sandbox.agentToken,
        policy,
        prompt: `${world.situation}\n\nThe charge id is ${world.chargeId}. Refund ${world.refundMinorUnits} (minor units).`,
        model: env.POME_AGENT_MODEL?.trim() || undefined,
      });
      return {
        summary: `${run.summary}\n\n(${run.steps} model turns)`,
        agentModel: env.POME_AGENT_MODEL?.trim() || "claude-sonnet-5",
        agentSdk: "vercel-ai-sdk",
      };
    },
  });

  console.log(formatRowReport(rowIdFor(inputs), pome));
  return { answer: summary, pome };
}

// ── The evaluator ───────────────────────────────────────────────────────────
//
// PURE CODE, and one function rather than two. No LLM judge anywhere: every
// verdict below was already reached by Pome against the twin's own tape, and
// re-judging it would only add noise.
//
// One function, for two reasons. LangSmith has no separate "classifier" channel
// the way Braintrust does — a categorical is just a feedback entry carrying
// `value` instead of `score` — so there is nothing structural to split along.
// And `_runEvaluators` wraps EACH evaluator in its own `traceable`, so a second
// one is a second traced run per row: on the Developer tier, where the binding
// limit is 5k traces a month, the evaluator half of this eval would cost twice
// what it needs to for no extra information.

/** One feedback key per criterion, plus Pome's own run score.
 *
 *  The envelope is the JS/TS one: `{results: [...]}`. Python's SDK takes a bare
 *  list; both SDKs read `key`, which is where Braintrust reads `name`. */
export function pomeVerdicts({ outputs }: { outputs?: Record<string, unknown> }): {
  results: EvaluationResult[];
} {
  const pome = outputs?.pome as PomeRunEvidence | undefined;
  if (!pome) {
    throw new Error(
      "this run's outputs carry no `pome` evidence, so there is nothing to grade. The target " +
        "returns `{answer, pome}` and the evaluator reads `outputs.pome`; a row that reaches here " +
        "without it either failed before finalize or had its output reshaped.",
    );
  }
  return {
    results: [
      ...pome.scores,
      ...pome.readings,
      // Pome's own 0–100 for the run, as one more key beside the per-criterion
      // ones. A convenience for sorting an experiment table — the per-criterion
      // keys are what you actually read.
      {
        key: "pome/run-score",
        score: pome.score / 100,
        comment: pome.dashboardUrl,
        evaluatorInfo: { run_id: pome.runId, session_id: pome.sessionId },
      },
    ],
  };
}

/** `evaluate()`'s own type for an evaluator, applied to ours. The assignment is
 *  the point: `tsc --noEmit` is the leg `gate:examples` runs, so a drift between
 *  what we return and what LangSmith accepts is a typecheck failure here rather
 *  than a 422 halfway through a run that has already minted six sandboxes. */
export const EVALUATORS: EvaluatorT[] = [pomeVerdicts];

/**
 * Whether a finished eval means the harness worked.
 *
 * Two things `evaluate()` will not tell you, both by swallowing:
 *
 *   `_forward`        catches the target's error, `console.error`s it, and
 *                     returns the row anyway. An eval in which every row failed
 *                     to mint a sandbox resolves and exits 0.
 *   `_runEvaluators`  catches the evaluator's error the same way. That row
 *                     finishes with no Pome feedback at all — every Pome key a
 *                     blank cell, which in an experiment table reads like a quiet
 *                     afternoon rather than like a failure.
 *
 * The verdict is deliberately NOT part of this. A red row is a successful eval —
 * this dataset has rows that are supposed to be red, and a harness that exited
 * non-zero on them could not have one.
 */
export function exitCodeFor(rows: readonly FeedbackRow[]): number {
  if (rows.length === 0) return 1;
  if (rows.some((row) => row.run?.error)) return 1;
  const graded = (row: FeedbackRow) =>
    (row.evaluationResults?.results ?? []).some((r) => r.key?.startsWith("pome/"));
  return rows.every(graded) ? 0 : 1;
}

/** One sandbox per row, and they are the billing unit — so hold a couple open
 *  at a time rather than the whole dataset. */
const DEFAULT_CONCURRENCY = 2;

export interface EvalOptions {
  maxConcurrency: number;
}

/**
 * How many rows run at once.
 *
 * `maxConcurrency` is the field to set, and one number is the point: `_evaluate`
 * feeds it to both legs (`targetConcurrency ?? maxConcurrency ?? 0`, and the
 * same for evaluation), so it bounds the target and the evaluators together.
 * Nothing in langsmith@0.9.0 runs rows unbounded — the shared queue is built
 * only `if (sharedConcurrency > 0)`, but when it is not, `_predict` and `_score`
 * each fall back to their own
 * `new PQueue({ concurrency: maxConcurrency === 0 ? 1 : maxConcurrency })`,
 * "maxConcurrency: 0 means sequential execution (matching Python behavior)" per
 * the SDK's own comment. So a cap of 0 or absent means one row at a time: the
 * miss costs wall-clock time, never a stampede of sandboxes. Hence the floor
 * below — an unset or bad `POME_EVAL_CONCURRENCY` should hold a couple of
 * sandboxes open, not quietly serialize the run.
 */
export function evalOptions(env: Env): EvalOptions {
  const requested = Number(env.POME_EVAL_CONCURRENCY);
  return {
    maxConcurrency:
      Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_CONCURRENCY,
  };
}

/**
 * One row's verdicts, for the terminal.
 *
 * `evaluate()` prints the experiment name and a compare URL, and that is all —
 * no scores, no categoricals. In the LangSmith UI these same verdicts are the
 * feedback columns; here they are lines.
 */
export function formatRowReport(rowId: string, evidence: PomeRunEvidence): string {
  const lines = [`\n── ${rowId} — Pome scored it ${evidence.score}/100`];
  for (const entry of evidence.scores) {
    // `null` is a real third answer, not a zero. A [code] criterion whose subject
    // was not there could not be evaluated, and LangSmith leaves a null out of
    // that key's aggregate rather than dragging it down.
    const mark = entry.score === 1 ? "PASS" : entry.score === 0 ? "FAIL" : "SKIP";
    lines.push(`   ${mark}  ${entry.key}   ${entry.comment}`);
  }
  for (const entry of evidence.readings) {
    lines.push(`   ${String(entry.value)}  ${entry.key}   ${entry.comment.slice(0, 100)}`);
  }
  lines.push(`   ${evidence.dashboardUrl}`);
  return lines.join("\n");
}

/** The experiment table, for the terminal. */
export function formatSummary(summaries: FeedbackSummary[]): string {
  const lines = ["\nExperiment summary", "=================="];
  for (const summary of summaries) {
    if (summary.kind === "categorical") {
      const tally = Object.entries(summary.values)
        .map(([value, count]) => `${value} ${count}`)
        .join(", ");
      lines.push(`${summary.key.padEnd(32)} ${tally}`);
      continue;
    }
    // The row count travels with the percentage. A mean over four of six rows is
    // not a mean over six, and printing it bare would hide that two rows could
    // not be evaluated at all.
    const dropped =
      summary.unanswered > 0
        ? `  (${summary.unanswered} row(s) could not be evaluated)`
        : "";
    lines.push(
      `${summary.key.padEnd(32)} ${(summary.mean * 100).toFixed(2)}%  n=${summary.counted}${dropped}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const env: Env = process.env;
  const options = evalOptions(env);
  const groupId = `lseval-${Date.now().toString(36)}`;

  // Check every distinct world's SHAPE once, before anything is provisioned. A
  // seed error caught here is one 422 in under a second; caught after the
  // fan-out it is N sandboxes that each spent quota to boot the wrong world.
  //
  // This is also this example's FIRST OUTBOUND CALL, and the ordering is
  // load-bearing: `scripts/smoke-examples.mjs` launches this file on every PR
  // with no credentials and every base URL on a dead loopback port, and it asks
  // whether the process reached an outbound call or died during wiring. The
  // marker is emitted from `controlPlane()`. Any check that can exit the process
  // — the LangSmith key below, for instance — has to come AFTER this one, or the
  // uncredentialed leg reads as an example that never got started.
  for (const world of WORLDS) {
    await validateSeed(env, ["stripe"], seedFor(world));
  }

  const missingKey = requireLangSmithKey(env);
  if (missingKey) throw new Error(missingKey);

  const client = new Client();
  const name = datasetName(DATASET);
  const dataset = await ensureDataset({ client, name, rows: DATASET });
  console.log(
    `${dataset.created ? "created" : "reusing"} LangSmith dataset "${name}"` +
      (dataset.uploaded > 0 ? `, uploaded ${dataset.uploaded} row(s)` : "") +
      `. ${DATASET.length} rows → ${DATASET.length} Pome sandboxes (group ${groupId}), ` +
      `${options.maxConcurrency} at a time.`,
  );

  const target: TargetT<DatasetRowInputs, RefundTaskOutput> = (inputs) =>
    runRow(inputs, env, groupId);

  const results = await evaluate(target, {
    data: name,
    evaluators: EVALUATORS,
    experimentPrefix: "pome-refund-agent",
    maxConcurrency: options.maxConcurrency,
    metadata: { group_id: groupId, twin: "stripe" },
    client,
  });

  for (const row of results.results) {
    if (row.run?.error) console.error(`row ${rowIdFor(row.example.inputs as DatasetRowInputs)} failed:`, row.run.error);
  }
  console.log(formatSummary(summarizeFeedback(results.results)));
  process.exit(exitCodeFor(results.results));
}

// NOT `import.meta.main`: it landed in Node 24.2 and this package's `engines`
// allows `>=24`, so on 24.0/24.1 it is `undefined`, this guard is false, and
// `npm start` prints nothing and exits 0 having run no eval at all. Realpath'd
// on BOTH sides because node resolves symlinks before deriving
// `import.meta.url`, so a bare resolve of argv[1] misses through a symlinked
// checkout (a git worktree, macOS's `/tmp`) in the same silent shape.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolvePath(process.argv[1])) : "";

if (ENTRY === SELF) {
  try {
    await main();
  } catch (err) {
    // The error OBJECT, never just `err.message`. Node prints name + stack +
    // `[cause]`, and `scripts/smoke-examples.mjs` classifies this output by
    // matching signatures that live outside the message — undici reports
    // `ECONNREFUSED` / `ENOTFOUND` only on `err.cause`, and `AbortError` is a
    // NAME. Logging the message alone would show the classifier strictly less
    // than an uncaught rejection did.
    console.error("\nintegration-examples/langsmith failed before the eval could finish:", err);
    process.exit(1);
  }
}
