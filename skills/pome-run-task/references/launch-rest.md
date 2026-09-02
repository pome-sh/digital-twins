# Launch a REST agent

Use this procedure when `examinee_launch.transport` is `rest`.

## Inputs

- `examinee_task.prompt`
- `examinee_launch.rest_urls`
- `examinee_launch.env`
- `examinee_launch.initial_events`, when present
- The Pome `session_id`

Treat `POME_AUTH_TOKEN` and `agent_token` as credentials. Do not write either value to a file or log.

## Check the project

1. Run `pome doctor` in the agent project.
2. Correct each manifest, routing, or egress failure.
3. Do not use a wildcard in `POME_EGRESS_ALLOW`.
4. Confirm that the agent reads `POME_<TWIN>_REST_URL` or another returned URL field.
5. Remove production API base URLs that bypass the returned twin URL.

`pome doctor` boots a temporary local GitHub twin during its full check. It does not validate every hosted URL.

## Map launch data

| Launch data | Process configuration |
| --- | --- |
| `rest_urls.<twin>` | Base URL for that twin. |
| `env.POME_<TWIN>_REST_URL` | Base URL when the agent reads process variables. |
| `env.POME_AUTH_TOKEN` | Bearer token for twin requests. |
| `initial_events` | Initial input for an event-driven agent. |
| `examinee_task.prompt` | Task input for the agent. |

The CLI also uses `POME_TASK`, `POME_TWIN_NAMES`, and per-twin MCP URL variables during normal runs.

Do not add `/api` to a Slack twin base URL. Slack routes use method paths such as `/conversations.list`.

## Launch

1. Create a clean process environment for this run.
2. Copy the returned `env` entries into that process environment.
3. Set each agent API client to its returned twin base URL.
4. Restrict network access to the allowed hosts in the launch data.
5. Disable unrelated internet tools when the launch data requires closed-book operation.
6. Deliver `initial_events` without changes when the field is present.
7. Start the agent with `examinee_task.prompt`.

## Detect completion

Treat the agent as idle only when it has completed the task and stopped making twin calls.

1. Monitor the process and its twin requests.
2. Stop waiting when the process exits successfully or waits for new input.
3. Call `finalize_run(session_id)` immediately.
4. Finalize before you stop any associated sandbox.

Output: Control returns to `pome-run-task` with a finalized Pome run.
