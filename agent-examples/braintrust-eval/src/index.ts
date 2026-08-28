// SPDX-License-Identifier: Apache-2.0
//
// Braintrust `Eval()`, where every dataset row gets its own world.
//
// ── What this example is ────────────────────────────────────────────────────
//
// Braintrust runs the eval. Pome is what the agent CALLS during it: a recorded,
// seeded digital twin of the SaaS APIs the agent hits in production. Both
// products now sell something called a sandbox and they are not the same thing —
// Braintrust's runs your eval code; Pome's is a Stripe-shaped digital twin your
// agent talks to, which remembers every request it received.
//
// One `Eval()` row → one `POST /v1/sandboxes` → one isolated Stripe world seeded
// from that row → a real agent driving it → `POST /v1/sandboxes/:id/finalize`.
// Every Pome criterion comes back as its own Braintrust score column.
//
// ── What it demonstrates, and why this failure ──────────────────────────────
//
// Braintrust already ships `agentAssertionScorer`: it asserts tool calls, their
// ordering and a call budget, over its own spans. This dataset is built around
// the one failure that is invisible to it. Both `POST /v1/refunds` calls are
// individually well-formed and correctly argued, and retrying after a 500 is
// textbook trajectory behaviour. The trajectory is clean. The money is wrong.
//
// That is trace versus tape. A span is the client's record of what the agent
// meant to do; the tape is the twin's record of what it actually received. An
// agent can produce a perfect span for a call that never happened; it cannot
// produce a refund row.

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { Eval } from "braintrust";

import { runAgent } from "./agent.js";
import { DATASET, RETRY_POLICIES, WORLDS, seedFor } from "./dataset.js";
import type { DatasetRow } from "./dataset.js";
import { assertWorldSeeded, readCharge, validateSeed, withPomeSandbox } from "./pome.js";
import type { Env, PomeRunEvidence } from "./pome.js";
import { criteriaFor, renderTask } from "./task.js";

/**
 * Whether a finished eval means the harness worked.
 *
 * `Eval()` does not throw when a row's task function does: it records the error
 * on that row and resolves. Left alone, an eval in which every row failed to
 * mint a sandbox exits 0 and reads, from CI, exactly like one that passed.
 *
 * The verdict is deliberately NOT part of this. A red row is a successful eval —
 * this dataset has rows that are supposed to be red, and a harness that exited
 * non-zero on them could not have one.
 */
export function exitCodeFor(results: ReadonlyArray<{ error?: unknown }>): number {
  if (results.length === 0) return 1;
  return results.some((r) => r.error !== undefined) ? 1 : 0;
}

/** One sandbox per row, and they are the billing unit — so hold a couple open
 *  at a time rather than the whole dataset. */
const DEFAULT_CONCURRENCY = 2;

export interface EvalOptions {
  /** `true` runs the eval locally and prints a summary instead of creating a
   *  Braintrust experiment. */
  noSendLogs: boolean;
  maxConcurrency: number;
}

/**
 * How this eval talks to Braintrust.
 *
 * With no `BRAINTRUST_API_KEY` it still runs — `noSendLogs` builds a local
 * summary instead of an experiment — so a reader can watch the demo work before
 * signing up, and so CI's launch check never reaches braintrust.dev.
 *
 * Note for anyone budgeting a free Starter account: scores are the metered unit
 * this design consumes, and it is per criterion per row. Four criteria over six
 * rows is 24 scores, against 10,000 a month.
 */
export function evalOptions(env: Env): EvalOptions {
  const requested = Number(env.POME_EVAL_CONCURRENCY);
  return {
    noSendLogs: !env.BRAINTRUST_API_KEY?.trim(),
    maxConcurrency:
      Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_CONCURRENCY,
  };
}

/** What the task hands the scorers. Braintrust scorers see `input`, `output`,
 *  `expected`, `metadata` and `trace` — and nothing else the task produced — so
 *  the Pome evidence has to travel inside the OUTPUT. That is the one shape
 *  constraint the whole recipe is built around. */
export interface RefundTaskOutput {
  /** The agent's own last word. */
  summary: string;
  pome: PomeRunEvidence;
}

/** One dataset row: one sandbox, one world, one agent, one graded run. */
export async function runRow(
  input: DatasetRow["input"],
  env: Env,
  groupId: string,
): Promise<RefundTaskOutput> {
  const { world, policy } = input;
  const task = renderTask(world);

  const { summary, pome } = await withPomeSandbox({
    env,
    twins: ["stripe"],
    taskMarkdown: task,
    seed: seedFor(world),
    groupId,
    criteria: criteriaFor(world),
    taskName: `${world.situationTitle} · ${policy}`,
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
        policy: RETRY_POLICIES[policy],
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

  console.log(formatRowReport(input.rowId, pome));
  return { summary, pome };
}

// ── The two scorers ─────────────────────────────────────────────────────────
//
// Both are PURE CODE. No LLM judge anywhere: every verdict below was already
// reached by Pome against the twin's own tape, and re-judging it would only add
// noise. It also keeps the example runnable on a free Braintrust Starter
// account — their built-in models want a work email or a card on file, and an
// LLM scorer would break that for anyone who signed up with a personal address.

/** One column per criterion. A scorer that returns an ARRAY of `{name, score}`
 *  emits one column per item, which is how a Pome criterion gets to be a
 *  first-class metric instead of a line inside somebody's summary blob. */
export function pomeCriteria({ output }: { output: RefundTaskOutput }) {
  return output.pome.scores;
}

/** Pome's own 0–100 for the run, as one more column beside the per-criterion
 *  ones. It is a convenience for sorting an experiment table — the per-criterion
 *  columns are what you actually read. */
export function pomeRunScore({ output }: { output: RefundTaskOutput }) {
  return {
    name: "pome/run-score",
    score: output.pome.score / 100,
    metadata: { run_id: output.pome.runId, dashboard_url: output.pome.dashboardUrl },
  };
}

/** One CATEGORICAL column per `[model]` criterion. Pome's narrator reads a
 *  `[model]` criterion and writes what it saw, but has no score authority over
 *  it — the row comes back `advisory` or `abstained`. Rendering that as 0 or 1
 *  would put a judge's opinion back on the dashboard as a number. */
export function pomeNarratorReadings({ output }: { output: RefundTaskOutput }) {
  return output.pome.classifications;
}

/**
 * One row's verdicts, for the terminal.
 *
 * Braintrust's own local summary — what you get with no `BRAINTRUST_API_KEY` —
 * prints score AVERAGES and no classifications at all, so the one thing this
 * example is about would be invisible to a reader trying it for the first time.
 * In the Braintrust UI these same verdicts are the columns; here they are lines.
 */
export function formatRowReport(rowId: string, evidence: PomeRunEvidence): string {
  const lines = [`\n── ${rowId} — Pome scored it ${evidence.score}/100`];
  for (const column of evidence.scores) {
    // `null` is a real third answer, not a zero. A [code] criterion whose
    // subject was not there could not be evaluated, and Braintrust leaves a null
    // out of that column's average rather than dragging it down.
    const mark = column.score === 1 ? "PASS" : column.score === 0 ? "FAIL" : "SKIP";
    lines.push(`   ${mark}  ${column.name}   ${column.metadata.reason ?? ""}`);
  }
  for (const column of evidence.classifications) {
    lines.push(`   ${column.id}  ${column.name}   ${String(column.metadata.reason ?? "").slice(0, 100)}`);
  }
  lines.push(`   ${evidence.dashboardUrl}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const env: Env = process.env;
  const options = evalOptions(env);
  const project = env.BRAINTRUST_PROJECT?.trim() || "pome-refund-agent";
  const groupId = `bteval-${Date.now().toString(36)}`;

  // Check every distinct world's SHAPE once, before anything is provisioned. A
  // seed error caught here is one 422 in under a second; caught after the
  // fan-out it is N sandboxes that each spent quota to boot the wrong world.
  // This is also this example's first outbound call, which is why the smoke
  // marker is emitted from `controlPlane()`.
  for (const world of WORLDS) {
    await validateSeed(env, ["stripe"], seedFor(world));
  }

  console.log(
    `${DATASET.length} rows → ${DATASET.length} Pome sandboxes (group ${groupId}), ` +
      `${options.maxConcurrency} at a time.` +
      (options.noSendLogs
        ? " No BRAINTRUST_API_KEY: running locally, printing a summary instead of creating an experiment."
        : ` Logging to Braintrust project "${project}".`),
  );

  const { results } = await Eval<DatasetRow["input"], RefundTaskOutput>(project, {
    data: DATASET,
    task: (input) => runRow(input, env, groupId),
    scores: [pomeCriteria, pomeRunScore],
    classifiers: [pomeNarratorReadings],
    maxConcurrency: options.maxConcurrency,
    metadata: { group_id: groupId, twin: "stripe" },
  }, { noSendLogs: options.noSendLogs });

  for (const row of results) {
    if (row.error) console.error(`row ${row.input.rowId} failed:`, row.error);
  }
  process.exit(exitCodeFor(results));
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
    console.error("\nbraintrust-eval failed before the eval could finish:", err);
    process.exit(1);
  }
}
