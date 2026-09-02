# gmail-retry-notify

This example uses the Vercel AI SDK and the Gmail twin REST API. It sends one announcement to five recipients.

The task tests retry behavior after partial delivery.

## Task

[`tasks/01-throttled-send.md`](tasks/01-throttled-send.md) configures a `rate-limited` fault on `messages.send`.

1. The first two send requests succeed.
2. The next three send requests return HTTP 429.
3. Later send requests can succeed.

The correct agent retries only failed recipients. It does not send another message to a recipient after a successful send.

The source currently selects `RETRY_RULE_V1`. This baseline tells the model to try each recipient once.

Select `RETRY_RULE_V2` in `src/index.ts` to test bounded retries and accurate delivery reporting:

```ts
const RETRY_RULE = RETRY_RULE_V2;
```

See [`VERIFICATION.md`](VERIFICATION.md) for recorded measurements.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- An Anthropic API key or Vercel AI Gateway key
- A Pome login for hosted runs

The default model is `anthropic/claude-opus-4-8`.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/gmail-retry-notify
npm ci
npm run typecheck
```

## Run

By default, `pome run` uses a hosted digital twin and returns hosted grading results.

```bash
pome login
export ANTHROPIC_API_KEY=sk-ant-...
pome run tasks/01-throttled-send.md
```

The task configuration requests three hosted trials. Use `-n <count>` to override that value.

To capture one local run, use `--local`:

```bash
pome run --local tasks/01-throttled-send.md
```

The local command writes trace and state files under `runs/<task-slug>/<run-id>/`. It does not grade the run or create a verdict.

Do not use `-n` with `--local`.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `GMAIL_AGENT_MODEL` | `anthropic/claude-opus-4-8` | Select the model. |
| `GMAIL_AGENT_MAX_STEPS` | `30` | Set the maximum number of tool steps. |
| `AI_GATEWAY_API_KEY` | unset | Route the model through Vercel AI Gateway. |
| `ANTHROPIC_API_KEY` | unset | Use Anthropic directly when no gateway key exists. |

The CLI supplies `POME_TASK`, `POME_GMAIL_REST_URL`, `POME_AUTH_TOKEN`, and `POME_GMAIL_TOKEN`.

For `pome run`, add `GMAIL_AGENT_MODEL` or `GMAIL_AGENT_MAX_STEPS` to `POME_AGENT_ENV_ALLOWLIST` when you set it.

## Troubleshooting

- If some recipients receive no message, check which retry rule is selected.
- If recipients receive duplicate messages, retry only the failed send request.
- If authentication fails, export `ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY`.
- If a custom variable has no effect, add its name to `POME_AGENT_ENV_ALLOWLIST`.
- If a local run has no score, this is correct. Local runs capture data only.
