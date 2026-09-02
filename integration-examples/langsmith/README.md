# Pome with LangSmith

This example runs LangSmith `evaluate()` over six rows. Each row uses a separate Pome sandbox.

The Pome sandbox contains a seeded Stripe digital twin. The agent sends Stripe REST requests to this twin.

LangSmith runs the evaluation. Pome records the requests, checks final state, and returns one verdict per criterion.

## Purpose

The example tests how an agent handles an uncertain write result.

Two seeded cases replace the response from the initial refund request with HTTP 500. The twin commits the refund before it replaces the response.

One policy retries the write immediately. The other policy retrieves the charge before it decides whether to retry.

A direct retry can create two partial refunds. Request traces alone do not prove the final account state.

The dataset contains three cases and two policies:

| Case | Charge | Required refund | Response replacement |
| --- | --- | --- | --- |
| `duplicate-charge` | `$100.00` | `$50.00` | After the refund commits |
| `cancelled-add-on` | `$75.00` | `$25.00` | After the refund commits |
| `goodwill-credit` | `$42.00` | `$10.00` | None. This is the control case. |

The refunds are partial. A full refund would leave no amount for a duplicate refund.

## Data Flow

1. The program validates each distinct seed with `POST /v1/seeds/validate`.
2. The program requires a LangSmith API key.
3. The program creates or reuses a LangSmith dataset.
4. LangSmith schedules the six rows through `evaluate()`.
5. Each target call creates one sandbox with `POST /v1/sandboxes`.
6. The program retrieves the seeded charge before it starts the agent.
7. The agent uses the returned `agent_token` to call the Stripe twin.
8. The target finalizes the live sandbox with `source: "twin-pull"`.
9. The evaluator converts `criteria_breakdown` to LangSmith feedback.

The integration uses `fetch` for the Pome API. It does not depend on an `@pome-sh/*` package.

LangSmith stores each row's case and policy identifiers. The current source resolves those identifiers to seeds during each run.

The dataset name includes a digest of the row identifiers. The program uploads missing rows if a prior upload stopped early.

## Prerequisites

- Node.js 24 or later.
- npm 11.5.1 or later.
- A Pome team API key.
- A LangSmith API key.
- An Anthropic API key for the included agent.

## Credentials

Set these variables before you run the example:

| Variable | Requirement | Use |
| --- | --- | --- |
| `POME_API_KEY` | Required | Authenticates the harness to the Pome control plane. Use a `pme_...` team key. |
| `LANGSMITH_API_KEY` | Required | Authenticates the LangSmith client. |
| `LANGCHAIN_API_KEY` | Alternative | The installed LangSmith SDK accepts this legacy name instead of `LANGSMITH_API_KEY`. |
| `ANTHROPIC_API_KEY` | Required | Authenticates the Vercel AI SDK Anthropic provider. |

Do not give `POME_API_KEY` to the agent. The sandbox response supplies a short-lived `agent_token` for twin requests.

LangSmith `evaluate()` has no local-only mode in this integration. A LangSmith key is required.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `POME_API_URL` | `https://api.pome.sh` | Selects the Pome control-plane base URL. |
| `POME_EVAL_CONCURRENCY` | `2` | Sets `maxConcurrency`. The value must be a positive integer. |
| `POME_AGENT_MODEL` | `claude-sonnet-5` | Selects the Anthropic model for the included agent. |

Invalid, zero, or absent `POME_EVAL_CONCURRENCY` values use the default value of 2.

## Install and Run

1. Enter the example directory.
2. Install its independent dependency tree.
3. Set all required credentials.
4. Start the evaluation.

```bash
cd integration-examples/langsmith
npm install
export POME_API_KEY="pme_..."
export LANGSMITH_API_KEY="..."
export ANTHROPIC_API_KEY="..."
npm start
```

This package is outside the root npm workspace. Run `npm install` in this directory.

The program creates a LangSmith experiment and prints each row's Pome verdicts. It also prints a terminal summary.

## Score Mapping

Pome criterion identifiers become LangSmith feedback keys with the `pome/` prefix.

| LangSmith feedback key | Type | Meaning |
| --- | --- | --- |
| `pome/refund-exists` | Numeric | At least one refund exists for the charge. |
| `pome/refund-count-is-one` | Numeric | Exactly one refund exists for the charge. |
| `pome/charge-succeeded` | Numeric | A charge has the `succeeded` status. |
| `pome/checked-before-retrying` | Categorical | The narrator reports `advisory` or `abstained`. |
| `pome/run-score` | Numeric | The Pome run score divided by 100. |

For `[code]` criteria, `passed` maps to `1` and `failed` maps to `0`. Other states map to `null`.

For `[model]` criteria, the evaluator returns `{ key, value }`. It does not convert the narrator result to a number.

The TypeScript evaluator must return `{ results: [...] }`. Each result uses `key`, not Braintrust's `name` field.

The expected pattern depends on model behavior. An agent that retries directly should fail `pome/refund-count-is-one` in both injected cases.

## Errors and Cleanup

- The program calls Pome seed validation before it checks the LangSmith key.
- A missing LangSmith key stops execution before dataset creation and sandbox creation.
- A missing or invalid `POME_API_KEY` produces a Pome `401` error.
- A Pome `402 quota_exceeded` error means too many sandboxes are open. Reduce `POME_EVAL_CONCURRENCY` or stop open sandboxes.
- Finalization requires a live sandbox and at least one recorded twin request. An empty tape returns `409 capture_incomplete`.
- A response without `criteria_breakdown` causes an error. The evaluator does not emit empty feedback.
- LangSmith can capture target or evaluator errors without rejecting `evaluate()`. The program checks returned rows before it exits.
- The program exits with status 1 for target errors, no returned rows, or rows without `pome/` feedback.
- Successful finalization grades the run and closes the sandbox.
- If a row fails after sandbox creation, the program requests deletion. It confirms deletion when Pome returns an ungraded-session discard token.
- Cleanup is best effort. The program preserves the row error if cleanup also fails.

## Verification

Run the local checks without network access or credentials:

```bash
npm test
npm run typecheck
```

The tests verify score mapping, dataset maintenance, requests, cleanup, and the LangSmith SDK boundary through a controlled client.

The tests do not verify a current live LangSmith account or hosted experiment. Treat the documented result pattern as an expectation.

Replace `src/agent.ts` to test another agent. Keep the `{ answer, pome }` target output that the evaluator reads.
