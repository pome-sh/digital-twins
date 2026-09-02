# Pome with LangSmith

This example runs LangSmith `evaluate()` with one Pome sandbox for each dataset row. Read the [shared scenario and Pome lifecycle](../shared/README.md) first.

LangSmith receives each Pome criterion as a separate feedback key. The included agent uses the Vercel AI SDK with Anthropic.

## Credentials

| Variable | Requirement | Use |
| --- | --- | --- |
| `POME_API_KEY` | Required | Authenticates control-plane calls. Use a `pme_...` team key. |
| `ANTHROPIC_API_KEY` | Required | Authenticates the included Anthropic provider. |
| `LANGSMITH_API_KEY` | Required | Authenticates the LangSmith client. |
| `LANGCHAIN_API_KEY` | Alternative | Replaces `LANGSMITH_API_KEY` through the SDK's legacy variable name. |

LangSmith `evaluate()` has no local-only mode in this example. You must supply one LangSmith key variable.

Do not give `POME_API_KEY` to the agent. The sandbox response supplies the agent token.

## Install and run

This package requires Node.js 24 or later. It has an independent dependency tree outside the root npm workspace.

```bash
cd integration-examples/langsmith
npm install
export POME_API_KEY="pme_..."
export LANGSMITH_API_KEY="..."
export ANTHROPIC_API_KEY="..."
npm start
```

The program creates or reuses a LangSmith dataset. It creates an experiment, prints each row's Pome verdicts, and prints a summary.

To test another agent, replace `src/agent.ts` and preserve its documented output shape.

## Evaluator mapping

| LangSmith interface | Pome data |
| --- | --- |
| Target output | `{ answer, pome }` |
| `pomeVerdicts` evaluator | Returns the TypeScript envelope `{ results: [...] }`. |
| `[code]` result | Uses `{ key, score, comment }`. |
| `[model]` result | Uses `{ key, value, comment }` without a numeric `score`. |
| Run score | Uses `pome/run-score` on a 0-1 scale. |

LangSmith feedback uses `key`, not Braintrust's `name` field. Keys use the `pome/` prefix.

See the [shared score mapping](../shared/README.md#score-mapping) for criterion meanings and status conversion.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `POME_API_URL` | `https://api.pome.sh` | Sets the Pome control-plane base URL. |
| `POME_EVAL_CONCURRENCY` | `2` | Sets `maxConcurrency`. Invalid values use `2`. |
| `POME_AGENT_MODEL` | `claude-sonnet-5` | Selects the Anthropic model. |

The dataset name includes a digest of its row identifiers. The program uploads missing rows when an earlier upload did not finish.

## Verified behavior

The tests run the real LangSmith `evaluate()` path through a controlled client. They require no credentials or network access.

```bash
npm test
npm run typecheck
```

The tests verify dataset maintenance, Pome requests, cleanup, feedback shape, summaries, and failed-row exit status. They do not verify a current LangSmith account or hosted experiment.
