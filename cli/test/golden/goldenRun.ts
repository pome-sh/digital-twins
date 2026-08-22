// SPDX-License-Identifier: Apache-2.0
//
// The golden-scenario harness (F-646) — a run whose correctness is known by
// CONSTRUCTION, pushed through the real evaluator path.
//
// WHAT MAKES IT GOLDEN. Nothing here decides what "correct" means. A fixture
// agent is a deterministic script that performs a fixed list of `tools/call`s
// against the real twins; whether that list satisfies the task is then answered
// by the same three modules a real run answers it with — the task parser, the
// criterion binder, and the check declaration's own `evaluate`. So a defect in
// any of them moves the answer for a run whose answer is not in question, which
// is the whole point: individual silent-scoring bugs were fixed one at a time
// and the class could regress freely.
//
// NO MODEL, NO NETWORK, NO SOCKET. The fixture agent is a script (there is no
// model anywhere in this file or its callers), the twins are booted in-process
// through `bootTwin` — the same registry entry `pome run` boots — and every call
// goes through `app.request`, so nothing binds a port. That is what makes the
// gate cheap enough to be always-on, and flake-proof enough to be believed.
//
// WHAT IS REAL AND WHAT IS NOT. Real: the task file (parsed by `parseTaskFile`,
// including its `## Seed State`), the twins and their routes, the recorder tape,
// `exportState()`, `bindCriterion`, and each check's declared `evaluate`. Not
// real: the aggregation at the bottom of this file. Evaluation is the product
// and the ENGINE lives in pome-cloud (`scripts/no-eval-in-oss.mjs` keeps it out
// of the OSS surface) — what is reachable here is the predicate layer, which is
// exactly the layer the bugs this gate exists for live in. The eleven lines of
// ratio arithmetic below are the gate's own assertion apparatus, not a scorer:
// they live under `test/`, are exported to nothing, and `gradedCount` is
// asserted by the caller precisely so a satisfaction of 0 can never be reached
// by an empty denominator.
//
// SUBSTRATES ARE SUPPLIED PER DECLARATION, never "everything we happen to
// have". A check that asks for `seed+final` gets the seed; one that asks for
// `tape` gets the tape; anything else gets `null` and must return a NAMED skip
// rather than read a hole. That is the engine's documented contract
// (`CheckSubstrate` in `@pome-sh/sdk/checks`), and honouring it is what makes
// this harness a place a future tape criterion can simply land in — the tape is
// already captured and already scoped per twin.

import { randomBytes } from "node:crypto";
import { sign } from "hono/jwt";

import { parseCheck, type CheckSubstrate, type CheckTapeEvent } from "@pome-sh/sdk/checks";
import { toTwinHttpEventRow } from "@pome-sh/sdk/server";

import { findCheck } from "../../src/cli/checks.js";
import { bindCriterion } from "../../src/cli/criterion-binding.js";
import { createRecorder } from "../../src/recorder/recorder.js";
import { parseTaskFile, seedStateForTwin } from "../../src/task/parseTask.js";
import { bootTwin, type TwinHarness } from "../../src/twin/twinHarness.js";

/** A recorded twin call in the shape `events.jsonl` persists, which is where
 *  `event_id` comes from — `recorder.events()` alone does not carry it, and a
 *  tape check cites its evidence by exactly that field. Derived from the real
 *  wrapper rather than re-declared, so it cannot drift from what finalize
 *  writes. */
type TapeRow = ReturnType<typeof toTwinHttpEventRow>;

/** One `tools/call` over a twin's real MCP JSON-RPC endpoint. This is the
 *  transport `agent-examples/support-triage`'s examinee uses, and — unlike the domain
 *  methods a unit test would reach for — it is the one that stamps `tool` on the
 *  recorded event. A tape assertion has nothing to read otherwise. */
export interface FixtureTwins {
  call(twin: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/** A deterministic fixture agent: a fixed list of tool calls, no model. */
export interface FixtureAgent {
  /** Names the run in failure output — `correct` / `wrong`. */
  readonly name: string;
  run(twins: FixtureTwins): Promise<void>;
}

/** One `[code]` criterion as the evaluator path answered it.
 *
 *  `checkId` is `null` only when the sentence bound NOTHING, which is the
 *  silent failure this gate exists to make loud: an unbound criterion is
 *  skipped by the grader and the denominator moves for a reason nobody wrote
 *  down. It is reported rather than thrown so the caller sees the WHOLE
 *  breakdown in one failure instead of the first broken line. */
export interface GradedCriterion {
  marker: string;
  twin: string;
  text: string;
  checkId: string | null;
  status: "passed" | "failed" | "skipped" | "unmatched";
  reason: string;
}

export interface GoldenRunOutcome {
  fixture: string;
  /** Every `[code]` criterion the task declares, in file order. */
  criteria: GradedCriterion[];
  /** `100 * passed / (passed + failed)`, skips excluded — the engine's rule. */
  satisfaction: number;
  /** The denominator that produced it. Asserted by the caller: a satisfaction
   *  of 0 over ZERO graded criteria is the all-skip defect wearing the right
   *  answer's clothes. */
  gradedCount: number;
  /** From the task's own `## Config`, never a literal here. */
  passThreshold: number;
  /** `[model]` criteria the gate deliberately did not grade. Reported, not
   *  silently dropped: "no LLM anywhere in CI" is a property worth asserting. */
  modelCriteria: number;
  /** The recorded tape, so a caller can assert the fixture actually ran and a
   *  future `substrate: "tape"` criterion has something to bind to. */
  tape: { total: number; byTwin: Record<string, number>; tools: string[] };
}

/**
 * Boot the task's twins on its own seed, run one fixture agent against them,
 * and grade the result through the real evaluator path.
 */
export async function runGoldenScenario(
  taskPath: string,
  fixture: FixtureAgent,
): Promise<GoldenRunOutcome> {
  const task = await parseTaskFile(taskPath);
  const twins = task.config.twins.length ? task.config.twins : ["github"];
  const runId = `golden-${fixture.name}`;

  // Same shape `runTask.ts` uses: one secret in the env for the twins' bearer
  // middleware, one token carrying the `pome-agent` login the seeds collaborate
  // as. The caller restores the env — see the gate's `afterAll`.
  const authSecret = process.env.TWIN_AUTH_SECRET ?? randomBytes(32).toString("hex");
  process.env.TWIN_AUTH_SECRET = authSecret;
  const token = await sign(
    {
      sid: runId,
      team_id: "tm_golden",
      login: "pome-agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    authSecret,
  );

  // ONE recorder across both twins, exactly as a multi-twin local run does it,
  // so the tape is a single ordered stream and `twin` is what scopes it.
  const recorder = createRecorder();
  const booted = new Map<string, TwinHarness>();
  const seedState: Record<string, unknown> = {};
  const finalState: Record<string, unknown> = {};

  try {
    for (const twin of twins) {
      const harness = await bootTwin({
        twin,
        seedState: seedStateForTwin(task, twin),
        runId,
        recorder,
      });
      booted.set(twin, harness);
      // BEFORE the fixture acts. This is the seed substrate a `seed+final`
      // delta compares against, and it is read through `exportState()` rather
      // than from the markdown so both sides of the delta are the same shape —
      // the seed schema and the export shape genuinely differ (twin-slack's
      // `user` vs `user_id`, and so on).
      seedState[twin] = await harness.exportState();
    }

    await fixture.run(mcpCaller(booted, runId, token));

    for (const [twin, harness] of booted) finalState[twin] = await harness.exportState();
    await recorder.flush?.();
    const tape = recorder.events().map(toTwinHttpEventRow);

    const criteria = task.criteria
      .filter((criterion) => criterion.type === "code")
      .map((criterion) => {
        const twin = criterion.twin ?? twins[0]!;
        const marker = `[code${criterion.twin ? `:${criterion.twin}` : ""}]`;
        return gradeCriterion(
          { marker, twin, text: criterion.text },
          { seed: seedState, final: finalState, tape },
        );
      });

    const passed = criteria.filter((row) => row.status === "passed").length;
    const failed = criteria.filter((row) => row.status === "failed").length;
    const gradedCount = passed + failed;

    return {
      fixture: fixture.name,
      criteria,
      satisfaction: gradedCount === 0 ? 0 : Math.round((100 * passed) / gradedCount),
      gradedCount,
      passThreshold: task.config.passThreshold,
      modelCriteria: task.criteria.filter((criterion) => criterion.type === "model").length,
      tape: {
        total: tape.length,
        byTwin: countBy(tape, (event) => event.twin),
        tools: [...new Set(tape.flatMap((event) => (event.tool ? [event.tool] : [])))].sort(),
      },
    };
  } finally {
    for (const harness of booted.values()) await harness.close();
    await recorder.close?.();
  }
}

/** The fixture agent's only affordance. Deliberately narrow — a fixture that
 *  could reach the domain directly would prove nothing about the routes, the
 *  recorder or the tool table, which is where three of this repo's shipped
 *  scoring bugs actually lived. */
function mcpCaller(
  booted: Map<string, TwinHarness>,
  sid: string,
  token: string,
): FixtureTwins {
  let nextId = 1;
  return {
    async call(twin, tool, args) {
      const harness = booted.get(twin);
      if (!harness) throw new Error(`golden fixture called twin "${twin}", which the task does not declare`);
      const app = harness.app as unknown as {
        request(path: string, init?: RequestInit): Promise<Response>;
      };
      const response = await app.request(`/s/${sid}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      });
      const body = (await response.json()) as {
        error?: { message?: string };
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      // A fixture whose call FAILED is not a wrong agent, it is a broken
      // fixture — and a broken fixture that limps on would grade a world nobody
      // built. Throwing here is what keeps "the wrong run scored 0" a statement
      // about the agent rather than about a typo in its tool arguments.
      if (body.error || body.result?.isError) {
        const detail = body.error?.message ?? body.result?.content?.[0]?.text ?? "unknown error";
        throw new Error(`golden fixture call ${twin}.${tool} failed: ${detail}`);
      }
      return body.result;
    },
  };
}

/** Bind one criterion to the check that grades it, then run that check's own
 *  `evaluate` against the substrates it declared. Every step here is the
 *  product's — this function chooses nothing. */
function gradeCriterion(
  criterion: { marker: string; twin: string; text: string },
  substrates: { seed: Record<string, unknown>; final: Record<string, unknown>; tape: TapeRow[] },
): GradedCriterion {
  const binding = bindCriterion(criterion);
  if (binding.kind !== "bound") {
    return {
      ...criterion,
      checkId: binding.kind === "corrupted" ? binding.checkId : null,
      status: "unmatched",
      reason:
        binding.kind === "corrupted"
          ? `corrupted_check_instance:${binding.checkId} (${binding.slot}=${JSON.stringify(binding.value)})`
          : `binds no check ${criterion.twin} declares (${binding.kind})`,
    };
  }

  const def = findCheck(binding.checkId);
  if (!def) {
    return { ...criterion, checkId: binding.checkId, status: "unmatched", reason: "declaration_not_found" };
  }
  const args = parseCheck(def, criterion.text);
  if (!args) {
    return { ...criterion, checkId: def.id, status: "unmatched", reason: "args_unparseable" };
  }
  // A criterion tagged with a twin the task does not declare has no world to be
  // answered against. Named rather than thrown, for the reason every predicate
  // in the vocabulary is written that way: a criterion may leave the
  // denominator, but it may never do it silently or take the run down with it.
  if (!(criterion.twin in substrates.final)) {
    return {
      ...criterion,
      checkId: def.id,
      status: "unmatched",
      reason: `twin "${criterion.twin}" was not booted for this task`,
    };
  }

  const substrate: CheckSubstrate<unknown> = {
    seed: def.substrate === "seed+final" ? (substrates.seed[criterion.twin] ?? null) : null,
    final: substrates.final[criterion.twin],
    tape: def.substrate === "tape" ? tapeFor(substrates.tape, criterion.twin) : null,
  };
  const outcome = def.evaluate(args, substrate);
  return {
    ...criterion,
    checkId: def.id,
    status: outcome.status ?? (outcome.passed ? "passed" : "failed"),
    reason: outcome.reason,
  };
}

/** The tape as a `substrate: "tape"` check sees it: scoped to ONE twin, oldest
 *  first. The engine does this scoping before a check is called, and the
 *  narrowing is load-bearing — an unsupported call to a different twin in a
 *  multi-twin session must not fail this twin's prohibition.
 *
 *  The cast is a WIDENING, not a claim: `TapeRow` carries every field
 *  `CheckTapeEvent` names — `toTwinHttpEventRow` is what puts `event_id` on it,
 *  which is the one a tape check cites evidence by — plus several
 *  (`state_delta`, `run_id`) it does not. It is spelled `as unknown as` only
 *  because `fidelity` is an enum on one side and a loose `string | null` on the
 *  other, which is the direction that cannot lose information. */
function tapeFor(tape: TapeRow[], twin: string): CheckTapeEvent[] {
  return tape
    .filter((event) => event.twin === twin)
    .map((event) => event as unknown as CheckTapeEvent);
}

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return counts;
}
