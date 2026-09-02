# Launch a managed agent

Use this procedure when `examinee_launch.transport` is `mcp` and the runtime uses Anthropic Managed Agents.

## Requirements

- Install the `ant` CLI with `brew install anthropics/tap/ant`.
- Authenticate with `ant auth login`.
- Read current command syntax from `ant --help`.

This reference defines the required mapping. The installed `ant` version defines its exact flags.

## Inputs

- The agent model and instructions.
- `examinee_task.prompt`.
- The complete `examinee_launch` object.
- The Pome `session_id`.

Treat each `mcp_servers[].bearer` value as a credential. Store it only in the managed credential store.

## Map launch data

| `examinee_launch` field | Managed-agent configuration |
| --- | --- |
| `network` | Runtime network policy and allowed hosts. |
| `env_packages` | Runtime packages. |
| `mcp_servers[]` | One MCP tool set for each entry. |
| `mcp_permission_policy` | Permission policy for every Pome MCP tool set. |
| `mcp_servers[].bearer` | Managed bearer credential bound to the matching server URL. |
| `memory_policy` | Per-run memory configuration. Do not attach production memory. |
| `initial_events` | Session initial events. Preserve order and content. |
| `instructions` | Additional assembly instructions from the launch response. |

Do not infer omitted policy. Follow the returned launch data.

## Create the runtime

1. Create the managed runtime environment.
2. Apply `network.mode` and `network.allowed_hosts` without expansion.
3. Install only the packages in `env_packages`.
4. Create one managed bearer credential for each MCP server URL.
5. Create one MCP tool set for each `mcp_servers` entry.
6. Apply `mcp_permission_policy` to every Pome MCP tool set.
7. Remove internet tools when the launch response requires closed-book operation.
8. Create per-run memory according to `memory_policy`.
9. Create the managed agent with the registered model and instructions.
10. Create a session with the returned `initial_events`.
11. Send `examinee_task.prompt` as the task input.

Do not place bearer values in the agent definition, task text, command history, or output.

## Detect completion

1. Poll the managed session with the current `ant` session command.
2. Continue while the agent emits tool calls or produces output.
3. Stop when the agent completes or waits for new input.
4. Call `finalize_run(session_id)` immediately.
5. Use the Pome `session_id`, not the managed-agent session identifier.
6. Finalize before you remove the managed session.

Output: Control returns to `pome-run-task` with a finalized Pome run.
