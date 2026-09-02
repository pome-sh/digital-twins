# minimal-viktor

This example uses the Vercel AI SDK with GitHub and Slack digital twins. It reviews pull requests and reports each result.

For each open pull request, the agent selects one result:

| Result | GitHub action | Slack action |
| --- | --- | --- |
| `MERGE` | Merge the safe pull request. | Report the repository, number, and title. |
| `BLOCK` | Submit a `REQUEST_CHANGES` review. | Report the reason and pull request link. |
| `FLAG-MALICIOUS` | Submit a `REQUEST_CHANGES` review. | Identify the author and request an account block. |

The agent checks the author login, CI status, pull request body, and changed files.

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

The task Markdown files contain inline seed data. Matching `.seed.json` files support repository probes.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- A model API key
- A Pome login for hosted runs

The default model is `alibaba/qwen-3-32b`. This model requires `AI_GATEWAY_API_KEY`.

Anthropic, Google, and OpenAI models can use their provider keys directly.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/minimal-viktor
npm ci
npm run typecheck
npm test
```

## Run

```bash
pome login
export AI_GATEWAY_API_KEY=...
pome run tasks/01-clean-merge.md -n 3
```

Run another task by changing the file path. Run all six task files with this command:

```bash
pome run tasks -n 3
```

The CLI reads `pome.json`, provisions both twins, and starts the agent with `npm start`.

To capture one local run:

```bash
pome run --local tasks/03-failing-ci.md
```

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `VIKTOR_MODEL` | `alibaba/qwen-3-32b` | Select a provider-qualified model. |
| `VIKTOR_MAX_STEPS` | `32` | Set the maximum number of tool steps. |
| `VIKTOR_SLACK_CHANNEL` | `eng-alerts` | Select the report channel. |
| `AI_GATEWAY_API_KEY` | unset | Route the model through Vercel AI Gateway. |
| `ANTHROPIC_API_KEY` | unset | Use an Anthropic model directly. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | unset | Use a Google model directly. |
| `OPENAI_API_KEY` | unset | Use an OpenAI model directly. |
| `VIKTOR_SLACK_REST_URL` | unset | Set a manual Slack twin URL. |
| `VIKTOR_SLACK_TOKEN` | unset | Set a manual Slack twin token. |

The CLI supplies `POME_TASK`, both twin REST URLs, and the required bearer tokens.

The runner forwards model keys by default. Add each custom `VIKTOR_*` variable to `POME_AGENT_ENV_ALLOWLIST`.

Do not change `VIKTOR_SLACK_CHANNEL` for the bundled tasks. Their checks use `eng-alerts`.

## Troubleshooting

- If the default model reports a missing key, export `AI_GATEWAY_API_KEY`.
- If a direct model reports a missing key, export the key for that provider.
- If a custom variable has no effect, add its name to `POME_AGENT_ENV_ALLOWLIST`.
- If Slack checks fail, keep `VIKTOR_SLACK_CHANNEL=eng-alerts` for bundled tasks.
