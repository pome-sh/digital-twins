# Pome with Braintrust

This example runs Braintrust `Eval()` with one Pome sandbox for each dataset row. Read the [shared scenario and Pome lifecycle](../shared/README.md) first.

Braintrust receives each Pome criterion as a separate score or classification column. The included agent uses the Vercel AI SDK with Anthropic.

## Credentials

| Variable | Requirement | Use |
| --- | --- | --- |
| `POME_API_KEY` | Required | Authenticates control-plane calls. Use a `pme_...` team key. |
| `ANTHROPIC_API_KEY` | Required | Authenticates the included Anthropic provider. |
| `BRAINTRUST_API_KEY` | Optional | Creates a hosted experiment. Without it, `Eval()` uses local `noSendLogs` mode. |

Do not give `POME_API_KEY` to the agent. The sandbox response supplies the agent token.

## Install and run

This package requires Node.js 24 or later. It has an independent dependency tree outside the root npm workspace.

```bash
cd integration-examples/braintrust
npm install
export POME_API_KEY="pme_..."
export ANTHROPIC_API_KEY="..."
npm start
```

Set `BRAINTRUST_API_KEY` before `npm start` to create a hosted Braintrust experiment.

To test another agent, replace `src/agent.ts` and preserve its documented output shape.

## Adapter mapping

| Braintrust interface | Pome data |
| --- | --- |
| Task output | `{ summary, pome }` |
| `pomeCriteria` scorer | Returns one `{ name, score, metadata }` item for each `[code]` criterion. |
| `pomeNarratorReadings` classifier | Returns one categorical item for each `[model]` criterion. |
| `pomeRunScore` scorer | Returns `pome/run-score` on a 0-1 scale. |

Braintrust column names use the `pome/` prefix. See the [shared score mapping](../shared/README.md#score-mapping) for criterion meanings and status conversion.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `POME_API_URL` | `https://api.pome.sh` | Sets the Pome control-plane base URL. |
| `POME_EVAL_CONCURRENCY` | `2` | Sets concurrent rows. Invalid values use `2`. |
| `POME_AGENT_MODEL` | `claude-sonnet-5` | Selects the Anthropic model. |
| `BRAINTRUST_PROJECT` | `pome-refund-agent` | Selects the Braintrust project. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Not set | Enables agent span export through OTLP. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Not set | Supplies comma-separated OTLP headers in `key=value` form. |
| `OTEL_SERVICE_NAME` | `pome-braintrust-refund-agent` | Sets the OpenTelemetry service name. |

OTLP is optional and does not affect score columns. Braintrust export requires authorization and `x-bt-parent` headers.

## Verified behavior

The local tests run the real Braintrust `Eval()` adapter in `noSendLogs` mode. They require no credentials or network access.

```bash
npm test
npm run typecheck
```

The tests verify dataset rows, Pome requests, cleanup, score columns, classifications, and failed-row exit status. They do not verify a current hosted Braintrust experiment.
