# pr-summary-agent

This example uses the Claude Agent SDK and the GitHub twin MCP API. It writes one summary comment for each open pull request.

Each summary describes the change, its purpose, its risk, and a review checklist. The agent compares base and head file contents.

## Task

[`tasks/01-summarize-prs.md`](tasks/01-summarize-prs.md) contains two pull requests in `acme/widgets`.

- PR #1 adds an optional `discount` parameter to pricing code.
- PR #2 changes only the repository README.

The agent must summarize both pull requests without merging or changing code.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- An Anthropic API key
- A Pome login for hosted runs

The agent reads `ANTHROPIC_API_KEY` first. If it is absent, the agent requests the key from the Infisical CLI.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/pr-summary-agent
npm ci
npm run typecheck
```

## Configure The API Key

Use a local variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or use Infisical:

```bash
infisical run -- pome run tasks/01-summarize-prs.md
```

Without `infisical run`, the agent runs this lookup:

```bash
infisical secrets get ANTHROPIC_API_KEY --plain --env=dev
```

## Run

```bash
pome login
pome run tasks/01-summarize-prs.md
```

To capture one local run:

```bash
pome run --local tasks/01-summarize-prs.md
```

## Run Against A Standalone Twin

Start the GitHub twin in the first terminal. Copy its `POME_AUTH_TOKEN`, then start the agent in the second terminal.

```bash
# terminal 1
npx @pome-sh/cli twin start github \
  --seed tasks/01-summarize-prs.seed.json

# terminal 2, from agent-examples/pr-summary-agent
export POME_AUTH_TOKEN=...
export ANTHROPIC_API_KEY=sk-ant-...
export POME_REPO_NAME=widgets
npm start
```

The supplied seed contains the two pull requests in `acme/widgets`.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Infisical lookup | Authenticate the Claude Agent SDK. |
| `POME_PR_SUMMARY_MODEL` | Claude CLI default | Request a Claude model or alias. |
| `INFISICAL_ENV` | `dev` | Select the Infisical environment slug. |
| `INFISICAL_PROJECT_ID` | unset | Select the Infisical project. |
| `POME_INFISICAL_SECRET_NAME` | `ANTHROPIC_API_KEY` | Select the Infisical secret. |
| `POME_GITHUB_MCP_URL` | standalone MCP URL | Select the GitHub twin MCP endpoint. |
| `POME_AUTH_TOKEN` | unset | Authenticate with a token from Pome. |
| `TWIN_AUTH_SECRET` | unset | Mint a standalone token when `POME_AUTH_TOKEN` is absent. |
| `POME_TASK` | bundled summary instruction | Replace the agent instruction. |
| `POME_REPO_OWNER` | `acme` | Set the default repository owner. |
| `POME_REPO_NAME` | `api` | Set the default repository name. |

For `pome run`, add each custom variable that you set to `POME_AGENT_ENV_ALLOWLIST`.
This includes `POME_PR_SUMMARY_MODEL` and the three Infisical variables above.

## Troubleshooting

- If key lookup fails, export `ANTHROPIC_API_KEY` or authenticate the Infisical CLI.
- If twin authentication fails, use the token from the current twin process.
- If a requested model changes, read the printed `model:` line.
