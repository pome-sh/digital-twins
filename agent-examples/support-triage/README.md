# support-triage

This example uses the Claude Agent SDK with GitHub and Slack digital twins. It handles a support report across both twins.

The agent reads `#support`, records the report in GitHub, and sends the tracking link to `#support`.

## Task

[`tasks/duplicate-issue.md`](tasks/duplicate-issue.md) contains a repeated report for `acme/orders-service`.

- Issue #47 directly matches the new report.
- Issue #23 is the tracking issue for the same problem.
- `docs/triage-policy.md` requires new occurrences on issue #23.
- The response in Slack must contain the issue #23 link.
- The agent must not create a new issue.

The default agent does not receive a policy-file hint. Set `POME_TRIAGE_POLICY_HINT=on` to add that instruction.

The files in `agents/` contain equivalent prompt variants for a managed-agent integration. The local package runs `src/index.ts`.

See [`VERIFICATION.md`](VERIFICATION.md) for recorded measurements.

## Requirements

- Node.js 24 or later
- The `pome` CLI
- Claude authentication
- A Pome login for hosted runs

Use `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or a stored `claude` login.

## Install

Run these commands from the repository root:

```bash
cd agent-examples/support-triage
npm ci
npm run typecheck
npm test
```

## Run The Default Agent

```bash
pome login
export ANTHROPIC_API_KEY=sk-ant-...
pome run tasks/duplicate-issue.md
```

The task configuration requests five hosted trials. Use `-n <count>` to override that value.

## Run With The Policy Hint

The runner does not forward custom variables unless you allow them.

```bash
POME_TRIAGE_POLICY_HINT=on \
POME_AGENT_ENV_ALLOWLIST=POME_TRIAGE_POLICY_HINT \
pome run tasks/duplicate-issue.md
```

## Capture A Local Run

```bash
pome run --local tasks/duplicate-issue.md
```

## Runtime Inputs

The Pome runner supplies these variables:

| Variable | Use |
| --- | --- |
| `POME_GITHUB_MCP_URL` | GitHub twin MCP endpoint. |
| `POME_SLACK_MCP_URL` | Slack twin MCP endpoint. |
| `POME_AUTH_TOKEN` | Bearer token for both twins. |
| `POME_TASK` | Task instruction. |

`POME_TRIAGE_POLICY_HINT=on` tells the agent to read `docs/triage-policy.md` before it selects an issue.

The agent disables Claude built-in tools and filesystem settings. It exposes only the two configured twin MCP APIs.

## Troubleshooting

- If the agent reports missing twin wiring, start it with `pome run`.
- If Claude authentication fails, use one authentication method from the requirements.
- If the policy hint has no effect, add `POME_TRIAGE_POLICY_HINT` to `POME_AGENT_ENV_ALLOWLIST`.
- If the default agent finds the policy without a hint, the model found repository guidance independently.
