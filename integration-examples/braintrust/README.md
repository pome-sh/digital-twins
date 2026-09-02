# Pome with Braintrust

This example runs a Braintrust `Eval()` over six rows. Each row uses a separate Pome sandbox.

The Pome sandbox contains a seeded Stripe digital twin. The agent sends Stripe REST requests to this twin.

Braintrust runs the evaluation code. Pome records the requests, checks final state, and returns one verdict per criterion.

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
2. Braintrust schedules the six dataset rows through `Eval()`.
3. Each row creates one sandbox with `POST /v1/sandboxes`.
4. The program retrieves the seeded charge before it starts the agent.
5. The agent uses the returned `agent_token` to call the Stripe twin.
6. The program finalizes the live sandbox with `source: "twin-pull"`.
7. Pome returns the run score and `criteria_breakdown`.
8. The Braintrust adapter converts each verdict to a score or classification column.

The integration uses `fetch` for the Pome API. It does not depend on an `@pome-sh/*` package.

## Prerequisites

- Node.js 24 or later.
- npm 11.5.1 or later.
- A Pome team API key.
- An Anthropic API key for the included agent.
- A Braintrust API key only if you want a hosted Braintrust experiment.

## Credentials

Set these variables before you run the example:

| Variable | Requirement | Use |
| --- | --- | --- |
| `POME_API_KEY` | Required | Authenticates the harness to the Pome control plane. Use a `pme_...` team key. |
| `ANTHROPIC_API_KEY` | Required | Authenticates the Vercel AI SDK Anthropic provider. |
| `BRAINTRUST_API_KEY` | Optional | Sends results to Braintrust. If absent, `Eval()` uses local `noSendLogs` mode. |

Do not give `POME_API_KEY` to the agent. The sandbox response supplies a short-lived `agent_token` for twin requests.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `POME_API_URL` | `https://api.pome.sh` | Selects the Pome control-plane base URL. |
| `POME_EVAL_CONCURRENCY` | `2` | Sets the number of concurrent rows. The value must be a positive integer. |
| `POME_AGENT_MODEL` | `claude-sonnet-5` | Selects the Anthropic model for the included agent. |
| `BRAINTRUST_PROJECT` | `pome-refund-agent` | Selects the Braintrust project. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Not set | Enables agent span export through OTLP. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Not set | Supplies comma-separated OTLP headers in `key=value` form. |
| `OTEL_SERVICE_NAME` | `pome-braintrust-refund-agent` | Sets the exported OpenTelemetry service name. |

OTLP is optional. Score columns do not depend on span export.

For Braintrust OTLP export, include authorization and `x-bt-parent` in `OTEL_EXPORTER_OTLP_HEADERS`.

## Install and Run

1. Enter the example directory.
2. Install its independent dependency tree.
3. Set the required credentials.
4. Start the evaluation.

```bash
cd integration-examples/braintrust
npm install
export POME_API_KEY="pme_..."
export ANTHROPIC_API_KEY="..."
npm start
```

Set `BRAINTRUST_API_KEY` before `npm start` to create a hosted experiment.

This package is outside the root npm workspace. Run `npm install` in this directory.

## Score Mapping

Pome criterion identifiers become Braintrust column names with the `pome/` prefix.

| Braintrust column | Type | Meaning |
| --- | --- | --- |
| `pome/refund-exists` | Numeric | At least one refund exists for the charge. |
| `pome/refund-count-is-one` | Numeric | Exactly one refund exists for the charge. |
| `pome/charge-succeeded` | Numeric | A charge has the `succeeded` status. |
| `pome/checked-before-retrying` | Classification | The narrator reports `advisory` or `abstained`. |
| `pome/run-score` | Numeric | The Pome run score divided by 100. |

For `[code]` criteria, `passed` maps to `1` and `failed` maps to `0`. Other states map to `null`.

For `[model]` criteria, the adapter returns a Braintrust classification. It does not convert the narrator result to a number.

The expected pattern depends on model behavior. An agent that retries directly should fail `pome/refund-count-is-one` in both injected cases.

## Errors and Cleanup

- A seed validation error stops the program before sandbox creation.
- A missing or invalid `POME_API_KEY` produces a Pome `401` error.
- A Pome `402 quota_exceeded` error means too many sandboxes are open. Reduce `POME_EVAL_CONCURRENCY` or stop open sandboxes.
- Finalization requires a live sandbox and at least one recorded twin request. An empty tape returns `409 capture_incomplete`.
- A response without `criteria_breakdown` causes an error. The adapter does not emit empty score columns.
- Braintrust can return row errors without throwing. The program exits with status 1 for an empty result or a failed row.
- Successful finalization grades the run and closes the sandbox.
- If a row fails after sandbox creation, the program requests deletion. It confirms deletion when Pome returns an ungraded-session discard token.
- Cleanup is best effort. The program preserves the row error if cleanup also fails.

## Verification

Run the local checks without network access or credentials:

```bash
npm test
npm run typecheck
```

The tests verify local `Eval()` wiring, score mapping, classifications, requests, and cleanup handling. They do not verify a current hosted Braintrust run.

Replace `src/agent.ts` to test another agent. Keep the returned Pome evidence shape that `src/index.ts` sends to the scorers.
