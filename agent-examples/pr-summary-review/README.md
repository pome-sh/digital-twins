# pr-summary-review

This example uses the Claude Agent SDK and the GitHub twin MCP API. It summarizes and reviews open pull requests.

For each pull request, the agent posts one summary and one formal review. It does not merge or change code.

The review event is `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`.

## Tasks

| Task | Expected review behavior |
| --- | --- |
| [`01-clean-prs.md`](tasks/01-clean-prs.md) | Do not request changes for two safe pull requests. |
| [`02-buggy-pr.md`](tasks/02-buggy-pr.md) | Request changes for a broken accumulation loop. |
| [`03-risky-pr.md`](tasks/03-risky-pr.md) | Request changes for a hardcoded secret and removed validation. |

The agent compares each changed file on the base and head branches before it submits a review.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- An Anthropic API key
- A Pome login for hosted runs

The agent reads `ANTHROPIC_API_KEY` first. If it is absent, the agent requests the key from the Infisical CLI.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/pr-summary-review
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
infisical run -- pome run tasks/01-clean-prs.md
```

The direct Infisical lookup uses `INFISICAL_ENV`, `INFISICAL_PROJECT_ID`, and `POME_INFISICAL_SECRET_NAME`.

## Run

By default, `pome run` uses a hosted digital twin and returns hosted grading results.

```bash
pome login
pome run tasks/01-clean-prs.md
pome run tasks/02-buggy-pr.md
pome run tasks/03-risky-pr.md
```

Run all task files with this command:

```bash
pome run tasks
```

To capture one local run, use `--local` with one task file:

```bash
pome run --local tasks/02-buggy-pr.md
```

The local command writes trace and state files under `runs/<task-slug>/<run-id>/`. It does not grade the run or create a verdict.

Do not use `-n` with `--local`.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Infisical lookup | Authenticate the Claude Agent SDK. |
| `POME_PR_REVIEW_MODEL` | Claude CLI default | Request a Claude model or alias. |
| `INFISICAL_ENV` | `dev` | Select the Infisical environment slug. |
| `INFISICAL_PROJECT_ID` | unset | Select the Infisical project. |
| `POME_INFISICAL_SECRET_NAME` | `ANTHROPIC_API_KEY` | Select the Infisical secret. |
| `POME_GITHUB_MCP_URL` | standalone MCP URL | Select the GitHub twin MCP endpoint. |
| `POME_AUTH_TOKEN` | unset | Authenticate with a token from Pome. |
| `TWIN_AUTH_SECRET` | unset | Mint a standalone token when `POME_AUTH_TOKEN` is absent. |
| `POME_TASK` | bundled review instruction | Replace the agent instruction. |
| `POME_REPO_OWNER` | `acme` | Set the default repository owner. |
| `POME_REPO_NAME` | `api` | Set the default repository name. |

For `pome run`, add each custom variable that you set to `POME_AGENT_ENV_ALLOWLIST`.
This includes `POME_PR_REVIEW_MODEL` and the three Infisical variables above.

## Troubleshooting

- If key lookup fails, export `ANTHROPIC_API_KEY` or authenticate the Infisical CLI.
- If a pull request has no review, inspect the agent output for a failed twin tool call.
- If a requested model changes, read the printed `model:` line.
- If a local run has no score, this is correct. Local runs capture data only.
