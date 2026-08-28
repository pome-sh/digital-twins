# `integration-examples/braintrust` — bundled Pome example

Braintrust's `Eval()` gives every dataset row **its own world**.

One row → one `POST /v1/sandboxes` → one isolated Stripe-shaped digital twin,
seeded from that row → a real agent driving it → `POST /v1/sandboxes/:id/finalize`.
Every Pome criterion comes back as **its own Braintrust score column**.

> **Two products, one word.** Braintrust sells a "sandbox" and so does Pome, and
> they are not the same thing. Braintrust's runs *your eval code*. Pome's is a
> digital twin of Stripe *your agent talks to* — an emulation that answers the
> same REST calls, backed by real SQLite state, and that remembers every request
> it received. Braintrust runs the eval; Pome is what the agent calls during it.

This is also the first example in this repository that drives a **hosted** Pome
sandbox rather than a local twin started by the CLI. It talks to
`api.pome.sh/v1` with plain `fetch` and takes no `@pome-sh/*` dependency at all,
so what you are reading is the HTTP contract, not an SDK wrapping it.

## The failure it demonstrates: a lost response, and a double refund

Braintrust already ships [`agentAssertionScorer`][bt-scorers] — declarative
assertions over tool calls, their ordering, and a call budget, read off its own
spans. This dataset is built around the one failure that is **invisible** to it.

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

That is *trace* versus *tape*. A span is the client's record of what the agent
meant to do. The tape is the twin's record of what it actually received. An
agent can emit a perfect span for a call that never happened; it cannot produce
a refund row.

### "Why not just send an Idempotency-Key?"

It is the first thing anyone who knows Stripe asks, and the answer is that it
**works** — this twin implements the real idempotency semantics, including under
the injected lost response. Measured against `api.pome.sh` on 2026-08-28: one
seeded world, two sandboxes, the only difference being the header on the retry.

| Retry | Refund rows | `amount_refunded` |
| --- | --- | --- |
| with the same `Idempotency-Key` | 1 | 5000 ✅ |
| without it | 2 | 10000 ❌ |

That is what makes this a fair exam rather than a rigged one. There are **two**
correct ways out of this world — send an idempotency key on the write, or read
the charge back before retrying — and only an agent that does neither lands the
second row. The `retry-on-5xx` arm does neither, and nothing in its instructions
tells it not to; it is following a rule a real team would have written down.

The rule is subtle enough to be worth stating: the middleware caches the
**handler's** status, not the wire's. An `after_handler` injection substitutes
the response after the row is committed, so a naive cache would see the 5xx,
decline to store it, and let the retry re-execute — which is exactly the case
`Idempotency-Key` exists for. `setHandlerResult` in the twin's
`idempotency.ts` is what keeps that straight.


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

## What comes back

Four criteria, four columns, one per criterion — not one aggregate. The criterion
ids you send at finalize become the column names.

| Column | Kind | What it says |
| --- | --- | --- |
| `pome/refund-exists` | numeric | A refund exists on the charge. **Passes for the careless agent too** — two rows are still "at least one". |
| `pome/refund-count-is-one` | numeric | **The red.** Exactly one refund row. The only check a double refund fails. |
| `pome/charge-succeeded` | numeric | A charge exists with status `succeeded`. |
| `pome/checked-before-retrying` | **categorical** | What Pome's narrator read in the tape about the agent's method. |
| `pome/run-score` | numeric | Pome's own 0–100 for the run, ÷ 100. A convenience for sorting; the per-criterion columns are what you read. |

The `[code]` / `[model]` split is the part to get right:

- **`[code]` verdicts are numbers.** They are facts about the twin's final
  state, reached by code, so `1` and `0` mean what a number should mean. A
  `[code]` criterion that could not be evaluated at all scores `null`, not `0` —
  Braintrust leaves a null out of that column's average, which is the honest
  arithmetic for "we did not find out".
- **`[model]` readings are categorical**, never `0`/`1`. Pome's narrator *reads*
  a `[model]` criterion and writes what it saw, but has no score authority over
  it: the row comes back `advisory` (it read the tape) or `abstained` (the
  criterion names something this run never did). Flattening either to a number
  would put a judge's opinion back on your dashboard as a score, which is
  exactly what Pome's narrator model removed. Braintrust carries them as
  [classifiers][bt-scorers] instead.

**The scorer is pure code.** No LLM judge anywhere: every verdict was already
reached against the twin's own tape, and re-judging it would only add noise. It
also keeps this runnable on a free Braintrust Starter account — their built-in
models want a work email or a card on file, and an LLM scorer would break that
for anyone who signed up with a personal address.

## Prerequisites

- Node.js 24+ and npm 11.5+.
- `POME_API_KEY` — a Pome **team** key (`pme_…`), from the dashboard or
  `pome login`.
- `ANTHROPIC_API_KEY` — the agent runs on the [Vercel AI SDK](https://ai-sdk.dev).
  Override the model with `POME_AGENT_MODEL`.
- `BRAINTRUST_API_KEY` — **optional**. Without it the eval still runs; it prints
  a local summary instead of creating an experiment.

## Install and run

```bash
cd integration-examples/braintrust
npm install
npm start
```

Like every bundled example, this package is deliberately **not** part of the root
npm workspace — that keeps the Braintrust and AI SDK trees out of the monorepo
install for everyone who is not running it.

Real output, measured 2026-08-27 against `api.pome.sh`:

```
6 rows → 6 Pome sandboxes (group bteval-mtbrgpkw), 3 at a time.

── duplicate-charge · retry-on-5xx — Pome scored it 67/100
   PASS  pome/refund-exists   charge "ch_test_200" has 2 refund row(s)
   FAIL  pome/refund-count-is-one   charge "ch_test_200" has 2 refund row(s), wanted 1 — 1 more than one refund per logical transaction
   PASS  pome/charge-succeeded   1 of 1 charge(s) have status "succeeded"
   advisory  pome/checked-before-retrying   1. The agent made a POST request to create a refund for 'ch_test_200' …

── duplicate-charge · verify-then-retry — Pome scored it 100/100
   PASS  pome/refund-exists   charge "ch_test_200" has 1 refund row(s)
   PASS  pome/refund-count-is-one   charge "ch_test_200" has 1 refund row(s), wanted 1
   PASS  pome/charge-succeeded   1 of 1 charge(s) have status "succeeded"
   advisory  pome/checked-before-retrying   1. The agent attempted to create a refund … (event_id: req_54684dde-…)

Experiment summary
==================
pome/refund-exists           100.00%
pome/refund-count-is-one      66.67%
pome/charge-succeeded        100.00%
pome/run-score                89.00%
```

`pome/refund-count-is-one` at 66.67% is the two `retry-on-5xx` rows in the two
injected worlds. The control world came back green on both arms, and its
`[model]` reading came back `abstained` — no refund call failed there, so there
was nothing for the narrator to read.

**Cost.** One sandbox per row, and a sandbox is Pome's billing unit;
`POME_EVAL_CONCURRENCY` (default 2) caps how many are open at once, which is
also what keeps a first run away from `402 quota_exceeded`. On the Braintrust
side, *scores* are the metered unit this design consumes — per criterion, per
row. Four criteria over six rows is 24 scores, against 10,000 a month on
Starter.

## The Pome half, in four calls

All of [`src/pome.ts`](./src/pome.ts), and the only Pome-specific code here.
A sibling example under a different eval framework copies that file unchanged
and writes its own caller.

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
every criterion grades `skipped` because its charge resolves nowhere, and a
Braintrust row of blank cells reads like a quiet afternoon. `assertWorldSeeded`
reads the charge back before the agent starts and refuses the row if it is not
there. The Stripe twin's default world is **empty**, so there is no fallback
state to fall back to — every row must seed.

## Layout

```
src/index.ts     Eval() wiring: the task function, the two scorers, the classifier
src/pome.ts      the Pome half — mint, assert, drive, finalize, stop
src/scoring.ts   Pome verdicts → Braintrust columns. Decides nothing.
src/agent.ts     the agent under test (Vercel AI SDK tool loop)
src/dataset.ts   the six rows, and the seed each one boots
src/task.ts      the criteria, and the task markdown they are rendered into
tasks/           the same task as a runnable Pome task file
```

[`tasks/lost-response-double-refund.md`](./tasks/lost-response-double-refund.md)
is generated from `src/task.ts` — `npm run task:write` regenerates it, and
`test/task.test.ts` fails if the committed file and the generator disagree. It
is the same task in Pome's own format: the prompt, the criteria and the seed
that every sandbox is minted with, written the way `pome tasks` and the
dashboard read one. Each row sends its own world's copy of it, base64-encoded,
as this mint's `task_source`.

`pome.json` here carries the agent's identity, its twin and its task directory,
and deliberately **no `command`**. Unlike the other examples this one is not a
single-task examinee the CLI launches: `npm start` runs the whole six-row eval
and mints its own sandboxes, so a `pome run` that launched it would sit watching
a sandbox nothing ever called. Braintrust is the runner here.

Swap `src/agent.ts` for your own agent and everything else is unchanged. Pome
grades what the agent *did to the twin*, not how it was built.

## Tests

```bash
npm test        # hermetic — no network, no credentials
npm run typecheck
```

`test/braintrust-seam.test.ts` runs a real `Eval()` locally (`noSendLogs`) over
two captured `finalize` responses and asserts the claim this example rests on:
one criterion, one column, and an advisory reading that never becomes a number.
The other suites cover the silent-wrong-answer class — the partial-refund trap,
the arms differing in exactly one sentence, a graded response with no
per-criterion detail refusing to render as zero columns. A crash is
`smoke:examples`, a type error is the typecheck leg.

[bt-scorers]: https://www.braintrust.dev/docs/evaluate/write-scorers
