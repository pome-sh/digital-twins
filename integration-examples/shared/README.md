# Shared Pome evaluation

The [Braintrust](../braintrust/README.md) and [LangSmith](../langsmith/README.md) examples run the same Pome evaluation. Each framework schedules six independent rows.

## Refund scenario

Each row gives an agent a seeded Stripe digital twin. The agent must issue one partial refund.

The dataset combines three cases with two retry policies:

| Case | Charge | Refund | First refund response |
| --- | --- | --- | --- |
| `duplicate-charge` | `$100.00` | `$50.00` | HTTP 500 after the refund commits |
| `cancelled-add-on` | `$75.00` | `$25.00` | HTTP 500 after the refund commits |
| `goodwill-credit` | `$42.00` | `$10.00` | Normal response |

The `retry-on-5xx` policy retries a failed call once. The `verify-then-retry` policy reads the charge before it retries a write.

The injected HTTP 500 does not undo the first refund. A direct retry can create a second refund. The partial amount leaves enough refundable value for that error.

The control case has no injected failure. It checks that both policies can complete a normal refund.

## Per-row lifecycle

The harness validates each distinct seed before it schedules rows. It uses `POST /v1/seeds/validate` for this preflight check.

Each row then uses four stages:

1. `mintSandbox()` calls `POST /v1/sandboxes` with the row seed and task.
2. `readCharge()` calls the live twin and checks the seeded charge.
3. `runAgent()` lets the agent call the live Stripe twin.
4. `finalizeRun()` calls `POST /v1/sandboxes/:id/finalize` with `source: "twin-pull"`.

The control-plane calls use `POME_API_KEY`. The agent receives only the sandbox's short-lived `agent_token`.

Finalization reads the recorded requests and final state from the live sandbox. It grades the run and closes the sandbox.

## Score mapping

Pome returns a `criteria_breakdown`. Both adapters add the `pome/` prefix to each criterion identifier.

| Key suffix | Kind | Result |
| --- | --- | --- |
| `refund-exists` | `[code]` | Confirms that the charge has a refund. |
| `refund-count-is-one` | `[code]` | Confirms that the charge has exactly one refund. |
| `charge-succeeded` | `[code]` | Confirms that a succeeded charge exists. |
| `checked-before-retrying` | `[model]` | Reports whether the agent checked the charge before another write. |

For `[code]` criteria, `passed` maps to `1` and `failed` maps to `0`. An unevaluated result maps to `null`, not `0`.

For `[model]` criteria, the adapter keeps `advisory` or `abstained` as a category. It does not convert the result to a number.

The adapters also publish `pome/run-score`. They divide Pome's 0-100 score by 100 for each framework's numeric field.

## Cleanup

Successful finalization closes the sandbox. If a row fails after creation, the harness sends `DELETE /v1/sandboxes/:id`.

An ungraded sandbox can return a discard token with HTTP 409. The harness sends a second delete request with that token.

Cleanup is best effort. A cleanup error does not replace the row error. A sandbox that remains open expires within 30 minutes.

If Pome returns `402 quota_exceeded`, reduce `POME_EVAL_CONCURRENCY` or stop open sandboxes. If finalization returns `409 capture_incomplete`, check that the agent called the twin.
