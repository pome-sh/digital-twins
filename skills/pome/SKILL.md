---
name: pome
description: Entry point for testing an agent with Pome. Routes managed-agent YAML to pome-intake, local repository agents to the local run path, and task authoring to pome-author-task. Use when the user says "test my agent with pome", "run pome", or "use pome".
---

# Pome (entry router)

You are the **coach**: you talk to the builder and to the Pome control MCP
(`mcp.pome.sh`). The **examinee** is their agent running against Pome's digital
twins. Pome grades the run from the twin tape. Read the builder's context and
route to the applicable coach skill.

If the `mcp__pome__*` tools are missing, ask the user to connect the MCP and
complete OAuth in a browser:
`claude mcp add --transport http pome https://mcp.pome.sh/mcp`.

## Route by context

| The builder arrives with… | Route |
| --- | --- |
| A Claude managed-agent YAML | Use `pome-intake`. |
| A registered local agent with no task | Use `pome-suggest-tasks`. |
| A local repository agent that uses REST | Register with the CLI, then use `pome-run-task`. See [Choose CLI or MCP registration](#choose-cli-or-mcp-registration). |
| A test idea | Use `pome-author-task`. |
| A drafted task | Use `pome-verify-seed`. |
| A verified task | Use `pome-run-task`. |

Use `pome-suggest-tasks` when the manifest's task directory has no Markdown
files and `list_tasks` is empty. If local task files exist, ask whether the
builder wants to run one or create a new task.

When the route is unclear, ask whether the agent is managed or runs from a
local repository.

## Choose CLI or MCP registration

Choose the registration surface from the agent location:

- For a local repository, run `pome register agent <name> [--twins ...]`.
  Only the CLI updates the Pome manifest and `.pome/link.json`.
- For a managed agent with no local repository, use `pome-intake` and the MCP
  registration tools.

Run an explicit CLI registration command verbatim. Do not replace it with MCP
`register_agent`. MCP registration does not write the local files.

For an existing registration, `register_agent(name, twins:[...])` can add twins
to the allowlist.

## This is not the CLI

The `pome` CLI records traces locally. Pome evaluates and scores hosted runs.

| CLI-era habit | Hosted (coach) equivalent |
| --- | --- |
| `pome register agent` | See [Choose CLI or MCP registration](#choose-cli-or-mcp-registration). |
| `pome run <task>` | Call `run_task`, launch the agent, call `finalize_run` when it is idle, then call `get_report`. |
| `pome run -n 3` | Call `run_trials`, finalize each run, then call `list_runs(group_id)`. |
| Local task files on disk | Call `save_task`, then browse with `list_tasks`. |
| "Where are my results?" | `get_report(run_id)` / `list_runs`, and the dashboard on `app.pome.sh` |

Disable `web_search` and `web_fetch` for the examinee. Put required information
in the seed. Save task source into the builder's team before the first run.
