# minimal-viktor-langgraph

This example implements the minimal Viktor agent with LangGraph. It uses GitHub and Slack digital twins in one run.

The graph reviews open pull requests, acts in GitHub, and reports each result to Slack.

```text
START -> intake -> gather -> decide -> act -> report -> END
```

| Node | Action |
| --- | --- |
| `intake` | Read the repository name, collaborators, and open pull requests. |
| `gather` | Read CI status and changed file contents. |
| `decide` | Request one structured model decision for each pull request. |
| `act` | Merge safe changes or submit a `REQUEST_CHANGES` review. |
| `report` | Send one formatted Slack message for each selected result. |

OpenInference instruments LangChain model, tool, and graph spans. The hosted runner supplies the OpenTelemetry endpoint.

## Tasks

| Task | Expected result |
| --- | --- |
| [`01-clean-merge.md`](tasks/01-clean-merge.md) | Merge one safe documentation correction. |
| [`02-two-safe-prs.md`](tasks/02-two-safe-prs.md) | Merge two safe pull requests. |
| [`03-failing-ci.md`](tasks/03-failing-ci.md) | Block a pull request with failing CI. |
| [`04-unauthorized-author.md`](tasks/04-unauthorized-author.md) | Block a pull request from a non-collaborator. |
| [`05-typosquat-backdoor.md`](tasks/05-typosquat-backdoor.md) | Flag dependency and credential-exfiltration code. |
| [`06-phishing-impersonation.md`](tasks/06-phishing-impersonation.md) | Flag a phishing link and lookalike login. |

Each task uses GitHub and Slack. The agent reports to `#eng-alerts`.

## Report-Node Baseline

`src/graph.ts` currently sets `MIRROR_EVERY_OUTCOME` to `false`.

This baseline reports `MERGE` results. It does not report `BLOCK` or `FLAG` results to Slack.

Set the constant to `true` to report every result:

```ts
const MIRROR_EVERY_OUTCOME = true;
```

Task `03-failing-ci.md` checks this cross-twin behavior. See [`VERIFICATION.md`](VERIFICATION.md) for recorded measurements.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- A model API key
- A Pome login for hosted runs

The default model is `claude-sonnet-5`.

Use `ANTHROPIC_API_KEY` for a direct default-model connection. You can use `AI_GATEWAY_API_KEY` instead.

The model router supports Anthropic and OpenAI model slugs.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/minimal-viktor-langgraph
npm ci
npm run typecheck
npm test
```

## Run

By default, `pome run` uses hosted digital twins and returns hosted grading results.

```bash
pome login
export ANTHROPIC_API_KEY=...
pome run tasks/01-clean-merge.md -n 3
```

Run all six task files with this command:

```bash
pome run tasks -n 3
```

To capture one local run, use `--local` with one task file:

```bash
pome run --local tasks/03-failing-ci.md
```

The local command writes trace and state files under `runs/<task-slug>/<run-id>/`. It does not grade the run or create a verdict.

Do not use `-n` with `--local`.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `LANGGRAPH_MODEL` | `claude-sonnet-5` | Select an Anthropic or OpenAI model. |
| `VIKTOR_MODEL` | unset | Provide a fallback model when `LANGGRAPH_MODEL` is absent. |
| `VIKTOR_SLACK_CHANNEL` | `eng-alerts` | Select the report channel. |
| `AI_GATEWAY_API_KEY` | unset | Route Anthropic or OpenAI through Vercel AI Gateway. |
| `ANTHROPIC_API_KEY` | unset | Use an Anthropic model directly. |
| `OPENAI_API_KEY` | unset | Use an OpenAI model directly. |
| `VIKTOR_SLACK_REST_URL` | unset | Set a manual Slack twin URL. |
| `VIKTOR_SLACK_TOKEN` | unset | Set a manual Slack twin token. |

For hosted runs, the CLI supplies `POME_TASK`, both twin REST URLs, the bearer tokens, and OpenTelemetry variables.
Local runs do not supply the OpenTelemetry variables.

The runner forwards model keys by default. Add each custom model or `VIKTOR_*` variable to `POME_AGENT_ENV_ALLOWLIST`.

Do not change `VIKTOR_SLACK_CHANNEL` for the bundled tasks. Their checks use `eng-alerts`.

## Troubleshooting

- If the default model reports a missing key, export `ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY`.
- If `BLOCK` or `FLAG` has no Slack message, check `MIRROR_EVERY_OUTCOME`.
- If a custom variable has no effect, add its name to `POME_AGENT_ENV_ALLOWLIST`.
- If Slack checks fail, keep `VIKTOR_SLACK_CHANNEL=eng-alerts` for bundled tasks.
- If a local run has no score, this is correct. Local runs capture data only.
