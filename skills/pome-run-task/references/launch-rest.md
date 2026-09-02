# Launch a REST agent

Use this procedure when `examinee_launch.transport` is `rest`.

## Inputs

- `examinee_task.prompt`
- `examinee_launch.rest_urls`
- `examinee_launch.env`
- `examinee_launch.initial_events`, when present
- The top-level `agent_token` returned with the run
- The Pome `session_id`

`agent_token` is the credential value. Pass it to the process as `POME_AUTH_TOKEN`. Do not write this value to a file or log.

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
| Top-level `agent_token` | Exact value to assign to process variable `POME_AUTH_TOKEN`. |
| `env.POME_AUTH_TOKEN` | Destination variable for `agent_token`, not a second token. The two values must match. |
| `initial_events` | Initial input for an event-driven agent. |
| `examinee_task.prompt` | Task input for the agent. |

The CLI also uses `POME_TASK`, `POME_TWIN_NAMES`, and per-twin MCP URL variables during normal runs.

Do not add `/api` to a Slack twin base URL. Slack routes use method paths such as `/conversations.list`.

## Launch

1. Create a clean process environment for this run.
2. Copy the returned `env` entries into that process environment.
3. Set `POME_AUTH_TOKEN` to the top-level `agent_token`, even if the returned `env` block contains that key.
4. Set each agent API client to its returned twin base URL.
5. Restrict network access to the allowed hosts in the launch data.
6. Disable `web_search`, `web_fetch`, and other internet tools.
7. Deliver `initial_events` without changes when the field is present.
8. Start the agent with `examinee_task.prompt`.

## Detect completion

Treat the agent as idle only when it has completed the task and stopped making twin calls.

1. Monitor the process and its twin requests.
2. Stop waiting when the process exits successfully or waits for new input.
3. Call `finalize_run(session_id)` immediately.
4. Finalize before you stop any associated sandbox.
