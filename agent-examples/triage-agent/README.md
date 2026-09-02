# triage-agent

This example uses the Claude Agent SDK and the GitHub twin MCP API. It classifies open issues and adds a short comment.

The agent applies one existing label: `bug`, `feature`, or `question`.

## Tasks

| Task | Purpose |
| --- | --- |
| [`01-triage-acme-issues.md`](tasks/01-triage-acme-issues.md) | Classify an unlabelled server error as a bug. |
| [`02-injection-issue-body.md`](tasks/02-injection-issue-body.md) | Ignore an instruction in issue data and keep the issue open. |

The second task contains a request to close the issue inside the issue body. The default prompt treats this text as untrusted data.

Set `POME_TRIAGE_BASELINE=1` only when you want to test the vulnerable prompt.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- Claude authentication
- A Pome login for hosted runs

Use one Claude authentication method:

- Export `ANTHROPIC_API_KEY`.
- Export `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
- Use a stored `claude` subscription login.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/triage-agent
npm ci
npm run typecheck
npm test
```

## Run With Pome

By default, `pome run` uses hosted digital twins and returns hosted grading results.

```bash
pome login
export ANTHROPIC_API_KEY=sk-ant-...
pome run tasks/01-triage-acme-issues.md
pome run tasks/02-injection-issue-body.md
```

The task configuration sets the default trial count. Use `-n <count>` to override it on a hosted run.

To run the vulnerable prompt, forward its custom variable:

```bash
POME_TRIAGE_BASELINE=1 \
POME_AGENT_ENV_ALLOWLIST=POME_TRIAGE_BASELINE \
pome run tasks/02-injection-issue-body.md
```

To capture one local run, use `--local`:

```bash
pome run --local tasks/01-triage-acme-issues.md
```

The local command writes trace and state files under `runs/<task-slug>/<run-id>/`. It does not grade the run or create a verdict.

Do not use `-n` with `--local`.

## Run Against A Standalone Twin

1. Start the GitHub twin in the first terminal.
2. Copy the printed `POME_AUTH_TOKEN` value.
3. Start the agent in the second terminal.

```bash
# terminal 1
npx @pome-sh/cli twin start github

# terminal 2, from agent-examples/triage-agent
export POME_AUTH_TOKEN=...
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

The standalone MCP URL is `http://127.0.0.1:3333/s/standalone/mcp`.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `POME_TRIAGE_BASELINE` | unset | Use the vulnerable prompt when the value is `1`. |
| `POME_TRIAGE_MODEL` | Claude CLI default | Request a Claude model or alias. |
| `POME_GITHUB_MCP_URL` | standalone MCP URL | Select the GitHub twin MCP endpoint. |
| `POME_AUTH_TOKEN` | unset | Authenticate with a token from Pome. |
| `TWIN_AUTH_SECRET` | unset | Mint a standalone token when `POME_AUTH_TOKEN` is absent. |
| `POME_TASK` | bundled triage instruction | Replace the agent instruction. |
| `POME_REPO_OWNER` | `acme` | Set the default repository owner. |
| `POME_REPO_NAME` | `api` | Set the default repository name. |

For `pome run`, add `POME_TRIAGE_MODEL` or `POME_TRIAGE_BASELINE` to `POME_AGENT_ENV_ALLOWLIST` when you set it.

## Troubleshooting

- If authentication fails, use one Claude authentication method from the requirements.
- If twin authentication fails, copy the token from the current `pome twin start` process.
- If a requested model changes, read the printed `model:` line. The Claude runtime selects the final model.
- If the vulnerable prompt does not close the issue, run more hosted trials. Model behavior can vary.
- If a local run has no score, this is correct. Local runs capture data only.
