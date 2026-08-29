# `integration-examples/langsmith` — bundled Pome example

LangSmith's `evaluate()` gives every dataset row **its own world**.

One row → one `POST /v1/sandboxes` → one isolated Stripe-shaped digital twin,
seeded from that row → a real agent driving it → `POST /v1/sandboxes/:id/finalize`.
Every Pome criterion comes back as **its own LangSmith feedback key**.

> **Two products, one word.** LangSmith sells a "sandbox" and so does Pome, and
> they are not the same thing. LangSmith's Sandboxes are ephemeral isolated
> containers for **agent-generated code** — bring your own image, TTLs, snapshot
> and fork. Pome's sandbox is a digital twin of Stripe *your agent talks to* — an
> emulation that answers the same REST calls, backed by real SQLite state, and
> that remembers every request it received. LangSmith runs the eval; Pome is what
> the agent calls during it.

This is the **second framework over the same recipe**.
[`integration-examples/braintrust`](../braintrust) runs these same six worlds
through the same four Pome calls under Braintrust's `Eval()`. The Pome half —
[`src/pome.ts`](./src/pome.ts) — is that example's file, copied; the framework
half is [`src/langsmith.ts`](./src/langsmith.ts). The *handoff* between the two
is a few lines; that file is larger because LangSmith needs three things
Braintrust supplies for free — a dataset that must exist before `evaluate()` will
run, an account it will not run without, and a summary nothing prints.
Copied rather than shared because each example here is a standalone npm package
outside the root workspace, with its own lockfile, which is the same reason
`minimal-viktor` and `minimal-viktor-langgraph` each carry their own
`model-routing.ts`. **Comments may differ between the two copies and do; behaviour
may not.**

It talks to `api.pome.sh/v1` with plain `fetch` and takes no `@pome-sh/*`
dependency at all, so what you are reading is the HTTP contract, not an SDK
wrapping it.

## The failure it demonstrates: a lost response, and a double refund

A charge for $100.00 needs a **partial** refund of $50.00. A failure-injection
rule loses the first refund's response *after* the write lands:

```json
{ "method": "POST", "path": "/v1/refunds", "attempt": 1,
  "mode": "after_handler", "status": 500 }
```

The refund row is written and the money moves. The caller is told the call
failed. Nothing in the response distinguishes that from a request that never
arrived.

- An agent that retries the 500 lands a **second** refund row. The customer gets
  $100.00 back instead of $50.00.
- An agent that reads the charge back first sees `amount_refunded: 5000` and
  stops.

Both refund calls are individually well-formed and correctly argued, and
retrying after a 5xx is textbook trajectory behaviour. **The trajectory is
clean; the money is wrong.** Only the twin's aggregate state can tell the two
runs apart.

That is *trace* versus *tape*. A LangSmith run is the client's record of what the
agent meant to do. The tape is the twin's record of what it actually received. An
agent can emit a perfect run for a call that never happened; it cannot produce a
refund row.

## The dataset

Six rows: three worlds × two retry policies. Both policies are things a real team
writes down, and both sound reasonable.

| Arm | The one sentence that differs |
| --- | --- |
| `retry-on-5xx` | "If a call comes back 5xx, retry it once — a 5xx means the request did not go through." |
| `verify-then-retry` | "…but a 5xx on a **write** does not tell you whether the write landed, so read the object back first." |

Everything else — the job, the tools, the world — is identical, and
`test/agent.test.ts` fails if that stops being true. Neither arm is ever told
that a refund can land on a 500: an agent told that would be following an
instruction, and the red would be authored rather than earned.

| World | Charge | Refund | First response lost? |
| --- | --- | --- | --- |
| `duplicate-charge` | `ch_test_200`, $100.00 | $50.00 | yes |
| `cancelled-add-on` | `ch_test_318`, $75.00 | $25.00 | yes |
| `goodwill-credit` | `ch_test_442`, $42.00 | $10.00 | no — the control |

⚠️ **The refund must be partial.** The twin computes
`refundable = amount - amount_refunded` and refuses anything larger, so a second
**full** refund is rejected with `charge_already_refunded`: one row is ever
written, the over-refund assertion passes, and the demo shows all green while
demonstrating nothing. `test/dataset.test.ts` pins it.

**The rows carry ids, not worlds.** `evaluate()` reads its examples out of
LangSmith's dataset store rather than out of an array, so anything sent in
`inputs` is state this repository no longer owns. Each row uploads
`{world, policy}` and the target resolves those against `src/dataset.ts` at run
time, so the seed you read here is always the seed that boots.

## What comes back

Four criteria, four feedback keys, one per criterion — not one aggregate. The
criterion ids you send at finalize become the key names.

| Feedback key | Kind | What it says |
| --- | --- | --- |
| `pome/refund-exists` | numeric | A refund exists on the charge. **Passes for the careless agent too** — two rows are still "at least one". |
| `pome/refund-count-is-one` | numeric | **The red.** Exactly one refund row. The only check a double refund fails. |
| `pome/charge-succeeded` | numeric | A charge exists with status `succeeded`. |
| `pome/checked-before-retrying` | **categorical** | What Pome's narrator read in the tape about the agent's method. |
| `pome/run-score` | numeric | Pome's own 0–100 for the run, ÷ 100. A convenience for sorting; the per-criterion keys are what you read. |

The `[code]` / `[model]` split is the part to get right:

- **`[code]` verdicts are numbers.** They are facts about the twin's final state,
  reached by code, so `1` and `0` mean what a number should mean. A `[code]`
  criterion that could not be evaluated at all scores `null`, not `0` —
  `ScoreType` is `number | boolean | null`, and LangSmith leaves a null out of
  that key's average, which is the honest arithmetic for "we did not find out".
- **`[model]` readings are categorical**, never `0`/`1`. They arrive as
  `{key, value}`. Pome's narrator *reads* a `[model]` criterion and writes what it
  saw, but has no score authority over it: the row comes back `advisory` (it read
  the tape) or `abstained` (the criterion names something this run never did).
  Flattening either to a number would put a judge's opinion back on your
  dashboard as a score, which is exactly what Pome's narrator model removed.

**The evaluator is pure code.** No LLM judge anywhere: every verdict was already
reached against the twin's own tape, and re-judging it would only add noise.

## Three mechanical differences from the Braintrust variant

Worth reading before you port either one to the other. All measured against
`langsmith@0.9.0`.

**1. The score key field is `key`, not `name`.** And a copy-paste port is not
rejected: `coerceEvaluationResult` carries an entry with no `key` straight
through, `_logEvaluationFeedback` reads `res.key` — `undefined` — and hands that
to `createFeedback` as the feedback key. The criterion's identity is gone before
the request is built and nothing throws.
[`test/langsmith-seam.test.ts`](./test/langsmith-seam.test.ts) drives the real SDK
to pin exactly that.

**2. Multiple scores: Python returns a bare list; JS/TS returns
`{results: [...]}`.** This example is TypeScript, so it returns the envelope. An
empty envelope is also silent: `_selectEvalResults` reads `results: []`, iterates
it zero times, and calls `createFeedback` never — no throw, no log, no feedback.
`readVerdicts` refusing a finalize response with no `criteria_breakdown` is what
keeps the array non-empty, and `exitCodeFor` requires every row to carry at least
one `pome/` key rather than trusting it does.

**3. There is no `noSendLogs`.** Braintrust's `Eval()` will run locally and print
a summary with no account. LangSmith's `evaluate()` calls
`client.createProject()` inside its own `start()`, **before the first
prediction**, so there is no local-only mode — this example needs a LangSmith key.
The upside of that ordering: a missing key costs nothing, because it fails before
any sandbox is minted. `requireLangSmithKey` says so in one sentence rather than
letting a bare 401 do it.

One more, less mechanical: `evaluate()` prints the experiment name and a compare
URL and nothing else — no scores, no categoricals. So this example prints its own
per-row report and summary, or the one thing it is about would be visible only in
a browser.

## ⚠️ The network restriction, and where it does not apply

LangSmith's *"Network Access: You cannot access the internet from a code
evaluator"* binds their **online / UI-defined** code evaluators — the ones that
run in LangSmith's cloud, limited to stdlib plus numpy, pandas, jsonschema, scipy
and scikit-learn, written inline in the UI.

**SDK evaluators passed to `evaluate()` run in your own process and are
unrestricted.** So this example needs no workaround: it could call the Pome API
directly from the evaluator if it wanted to. The evidence travels through the
target's returned dict because that is cleaner and costs no second round trip,
not because it has to.

*If you want Pome scores on production traces* — inside LangSmith's online
evaluators rather than an offline `evaluate()` run — then the constraint does bite,
and the answer is the same shape: put the finished Pome report into the run's
outputs at trace time so the cloud-side evaluator can read it without a network
call. That is a narrower and later use case, and this example is deliberately not
built around it. (Verified against LangSmith's docs 2026-08-27.)

## Prerequisites

- Node.js 24+ and npm 11.5+.
- `POME_API_KEY` — a Pome **team** key (`pme_…`), from the dashboard or
  `pome login`.
- `LANGSMITH_API_KEY` — from <https://smith.langchain.com/settings>. The legacy
  `LANGCHAIN_API_KEY` works too; the SDK reads `LANGSMITH_* || LANGCHAIN_*`.
- `ANTHROPIC_API_KEY` — the agent runs on the [Vercel AI SDK](https://ai-sdk.dev).
  Override the model with `POME_AGENT_MODEL`.

## Install and run

```bash
cd integration-examples/langsmith
npm install
npm start
```

Like the other examples, this package is deliberately **not** part of the root
npm workspace — that keeps the LangSmith and AI SDK trees out of the monorepo
install for everyone who is not running it.

The terminal output has this shape — one block per row as it finishes, then the
table `evaluate()` does not print:

```
created LangSmith dataset "pome-lost-response-double-refund-<digest>", uploaded 6 row(s).
6 rows → 6 Pome sandboxes (group lseval-<id>), 2 at a time.
Starting evaluation of experiment: pome-refund-agent-<suffix>
View results at https://smith.langchain.com/o/…/datasets/…/compare?selectedSessions=…

── duplicate-charge · retry-on-5xx — Pome scored it 67/100
   PASS  pome/refund-exists   charge "ch_test_200" has 2 refund row(s)
   FAIL  pome/refund-count-is-one   charge "ch_test_200" has 2 refund row(s), wanted 1 — 1 more than one refund per logical transaction
   PASS  pome/charge-succeeded   1 of 1 charge(s) have status "succeeded"
   advisory  pome/checked-before-retrying   1. The agent made a POST request to '/v1/refunds' ... 5. The agent
   https://app.pome.sh/runs/run_…

Experiment summary
==================
pome/refund-exists               100.00%  n=6
pome/refund-count-is-one         66.67%  n=6
pome/charge-succeeded            100.00%  n=6
pome/checked-before-retrying     advisory 4, abstained 2
pome/run-score                   89.00%  n=6
```

`pome/refund-count-is-one` at 66.67% would be the two `retry-on-5xx` rows in the
two injected worlds. The control world should come back green on both arms, and
its `[model]` reading `abstained` — no refund call failed there, so there is
nothing for the narrator to read.

> **What has and has not been run.** The Pome half is
> [`braintrust`](../braintrust)'s code, which was verified end to end
> against `api.pome.sh` on 2026-08-27, three times, same split each run. The
> LangSmith half is verified against the real SDK by
> `test/langsmith-seam.test.ts`, which drives an actual `evaluate()` — real target
> wrapping, real evaluator coercion, real feedback assembly — against a stub
> client. Neither of those is a run against a live LangSmith account, and this
> variant has not had one; a verification screenshot was explicitly out of scope
> for it.

## Cost, on the Developer tier

LangSmith's **Developer** plan is **$0** and **1 seat**, and includes **5,000 base
traces per month**, then pay-as-you-go. On Developer **with no payment method on
file there is a hard stop at 5,000 traces**. Tracing, datasets, and both offline
and online evals are all available on it; Deployment, Engine and Tuned Evaluators
are not.

Traces are the binding limit for this design, so the arithmetic is worth doing:
one traced run for the target plus one for the evaluator is **about two per row**,
so six rows is roughly a dozen. The agent's own model calls are **not** traced
here — `evaluate()` auto-traces the target function and nothing inside it. If you
want them, `langsmith/experimental/vercel`'s `wrapAISDK(ai)` will add a run per
LLM call and per tool call, which is a much richer trace and a much larger share
of 5,000.

⚠️ **Experiment runs are created at extended retention (400 days) by default**,
which is the more expensive tier — eval traffic is not billed like ordinary base
traces. Fine at recipe scale; worth knowing before you point a 500-row dataset at
it.

On the Pome side, one sandbox per row, and a sandbox is Pome's billing unit.
`POME_EVAL_CONCURRENCY` (default 2) caps how many are open at once, which is also
what keeps a first run away from `402 quota_exceeded`. Set it via
`maxConcurrency`: `targetConcurrency` **alone** does not bound anything —
`evaluate()` builds a shared queue only `if (maxConcurrency ?? 0) > 0`, so a cap
of 0 or absent means every row runs at once.

## The Pome half, in four calls

All of [`src/pome.ts`](./src/pome.ts), and the only Pome-specific code here — the
same file the Braintrust variant carries.

```
POST /v1/seeds/validate           does this world parse? free, nothing provisioned
POST /v1/sandboxes                twins + seed + task_source → session_id, agent_token, per_twin
GET  <api_url>/v1/charges/:id     did the world actually ARRIVE? (see below)
POST /v1/sandboxes/:id/finalize   source: "twin-pull" → run_id, score, criteria_breakdown
```

**`source: "twin-pull"` is what makes this reachable over plain HTTP.** The
control plane reads the tape and the final state off the live twin itself, so
there is nothing for you to capture, gzip or upload. Two conditions: the sandbox
must still be live (the tape is in-sandbox and does not survive teardown), and
the agent must actually have called the twin — an empty tape comes back
`409 capture_incomplete` rather than a score of zero, which is the right way
round.

**Three credentials, and they are not interchangeable.**

| | Reaches | Give it to |
| --- | --- | --- |
| `POME_API_KEY` (`pme_…`) | `api.pome.sh/v1` | your harness |
| `agent_token` | the twins on `twins.pome.sh` | your agent |
| `provider_credentials.stripe.api_key` | nothing, on its own | — |

The third one is the key the twin expects to *see* inside the sandbox, the shape
a real Stripe SDK would send. It does **not** authenticate you to
`twins.pome.sh`: a call bearing it comes back `404 No twin pod for this session`,
because the proxy resolves which sandbox you mean from the bearer and only the
`agent_token` says. Measured 2026-08-27.

⚠️ **Check that the world arrived, not just that it parsed.** The Stripe twin's
seed schema is a plain `z.object`, not `.strict()`, so a mistyped top-level key
is dropped in **silence** and `POST /v1/seeds/validate` answers `valid: true` for
a seed that will boot an empty world. (gmail and linear refuse an unknown key;
github, slack and stripe do not.) The failure that produces is the worst kind:
every criterion grades `skipped` because its charge resolves nowhere, and a row
of blank cells reads like a quiet afternoon. `assertWorldSeeded` reads the charge
back before the agent starts and refuses the row if it is not there. The Stripe
twin's default world is **empty**, so there is no fallback state to fall back to —
every row must seed.

## Layout

```
src/index.ts      evaluate() wiring: the target, the one evaluator, the reports
src/langsmith.ts  the framework half — dataset upkeep, the key check, the summary
src/pome.ts       the Pome half — mint, assert, drive, finalize, stop (a copy)
src/scoring.ts    Pome verdicts → LangSmith feedback. Decides nothing.
src/agent.ts      the agent under test (Vercel AI SDK tool loop)
src/dataset.ts    the six rows, the seed each one boots, and the id → world binding
src/task.ts       the criteria, and the task markdown they are rendered into
tasks/            the same task as a runnable Pome task file
```

The agent is a Vercel AI SDK tool loop rather than a LangGraph one, even though
LangSmith is LangChain's own product, and that is deliberate: this example and the
Braintrust one should differ in exactly one thing — the eval framework — for the
same reason the dataset's two arms differ in exactly one sentence. Swap
`src/agent.ts` for your own agent, LangGraph included, and everything else is
unchanged. Pome grades what the agent *did to the twin*, not how it was built.
(Use LangChain or LangGraph and you get richer traces for free, since the SDK
instruments them — and spend more of the 5,000.)

**The dataset name carries a digest of the row set.** Because `evaluate()` serves
its examples from LangSmith and not from `DATASET`, a reader who adds a world and
re-runs would otherwise be served the *old* rows under the same name and shown a
summary of the right shape and the wrong content. A changed row set is a different
dataset, so the two cannot be confused; an interrupted first upload is topped up
rather than reused short.

[`tasks/lost-response-double-refund.md`](./tasks/lost-response-double-refund.md)
is generated from `src/task.ts` — `npm run task:write` regenerates it, and
`test/task.test.ts` fails if the committed file and the generator disagree. It is
the same task in Pome's own format: the prompt, the criteria and the seed that
every sandbox is minted with, written the way `pome tasks` and the dashboard read
one. It is byte-identical to the Braintrust variant's copy, because it is the same
task in the same world. Each row sends its own world's copy of it, base64-encoded,
as this mint's `task_source`.

`pome.json` here carries the agent's identity, its twin and its task directory,
and deliberately **no `command`**. Unlike the other examples this one is not a
single-task examinee the CLI launches: `npm start` runs the whole six-row eval and
mints its own sandboxes, so a `pome run` that launched it would sit watching a
sandbox nothing ever called. LangSmith is the runner here.

## Tests

```bash
npm test        # hermetic — no network, no credentials
npm run typecheck
```

`test/langsmith-seam.test.ts` runs a real `evaluate()` against a stub client and
asserts the claim this example rests on: one criterion, one feedback key, and an
advisory reading that never becomes a number. It also pins the `name`-instead-of-
`key` rewrite, because that failure is invisible from the outside.

`test/pome.test.ts` is the Braintrust variant's suite case for case. That is what
makes "the Pome half is the same in both" checkable rather than asserted: if the
two copies ever disagree about what an HTTP call does, one of the two suites goes
red.

The typecheck leg matters more here than usual. `pomeVerdicts` is assigned to
LangSmith's own `EvaluatorT`, the target to `TargetT`, and the feedback fields to
`ScoreType` / `ValueType` from `langsmith/schemas` — so a drift between what this
example returns and what the SDK accepts is a `tsc` failure rather than a 422
halfway through a run that has already minted six sandboxes.

A crash is `smoke:examples`, a type error is the typecheck leg.
