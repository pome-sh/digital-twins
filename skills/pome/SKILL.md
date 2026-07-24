---
name: pome
description: Entry point for testing an agent with Pome — routes to the right coach skill by context (managed-agent YAML → pome-intake, local repo / self-hosted REST agent → the local-examinee run path, plain task authoring → pome-author-task) and maps CLI-era commands to the hosted MCP tools. Use when the user says "test my agent with pome", "run pome", or "use pome". Supersedes the Gen-1 /pome-test skill.
---

<!--
Naming decision (F-801, 2026-07-22): this router is named `pome`, NOT
`pome-test`. The Gen-1 skill that the retired `pome skills install` command
seeded may still occupy `pome-test` in users' skills directories, so a Gen-2
skill with the same name would collide for anyone who has Gen-1. Gen-1
`pome-setup` / `pome-test` were retired at F-859 (M2) to tombstones that
redirect here, then removed from the CLI at F-893; this router owns the shared
trigger phrases so the two generations never claim the same entry point.
-->

# Pome (entry router)

You are the **coach**: you talk to the builder and to the Pome control MCP
(`mcp.pome.sh`). The **examinee** is a sandbox clone of their agent, run
against Pome's digital twins and graded from the live twin tape. This skill
does one thing: read the builder's context and hand off to the right coach
skill. Do not improvise a pipeline here.

If the `mcp__pome__*` tools are missing, the MCP isn't connected: ask the user
to connect and authenticate it (interactive OAuth — needs a human in a
browser): `claude mcp add --transport http pome https://mcp.pome.sh/mcp`.

## Route by context

| The builder arrives with… | Route |
| --- | --- |
| A **Claude managed-agent YAML** (pasted, or "test my managed agent") | `pome-intake` — collect the clone scope, register via `intake_clone_scope`, report twin coverage |
| A **registered own agent** — a repo with a `pome.json` but **no task yet** ("test my agent" / "what should I test?", `tasks/` empty and `list_tasks` empty) | `pome-suggest-tasks` — read the manifest (`twins`) + the agent's prompt/code, propose grounded candidates, interview to pick one, then the authoring chain |
| A **local repo agent / self-hosted process** (talks REST, no managed-agent YAML) | The local-examinee path: register with the **CLI** — `pome register agent <name> [--twins …]`, which writes `pome.json` + `.pome/link.json` and sets local transport (the MCP `register_agent` does **not** — see **One register verb** below). Then `pome-run-task` — `run_task` mints the session and the launch spec; launch the process yourself via the REST launcher (`pome-run-task/references/launch-rest.md`), which **preflights the wiring** (config → twin reachable → routing → egress floor, the `pome doctor` checks) before it launches |
| "**What should I test?**" / a worry to turn into a graded check | `pome-author-task` — library-first authoring, `[code]`/`[model]` criteria, validate → dry-run → `save_task` |
| A drafted task, first run coming up ("is my seed right?") | `pome-verify-seed` — fair-exam triage before anything runs |
| A verified task to execute ("run my tasks", "how did my agent do?") | `pome-run-task` — mint, launch, `finalize_run` on idle, narrate `get_report` |

**Registered but untested (the F-891 cold start).** Detect it locally first, so
the route resolves even before the MCP is connected: a `pome.json` at the repo
root whose `tasks` dir holds no `.md`, and — when the MCP is up — an empty
`list_tasks`. Both empty → the builder has an agent but no first task →
`pome-suggest-tasks`. If local task files exist but the catalog is empty (a
bundled-example repo), don't auto-fire suggestion: offer the choice — run the
existing task, or suggest a fresh one grounded in the agent.

When in doubt, ask one question — "is your agent a Claude managed agent, or a
process you run yourself?" — and route on the answer. The full journey is
intake → author → verify → run; enter wherever the builder actually is.

## One register verb — CLI vs MCP

There is one *concept* — register an agent — reached by two surfaces that are
**not** interchangeable. Route by whether a local repo is in play; never
silently swap one for the other:

- **Local repo present** (a `pome.json`-bearing repo the builder runs
  themselves — the self-hosted / REST examinee) → the **CLI**:
  `pome register agent <name> [--twins …]`. Only the CLI resolves the hosted
  identity **and** writes the local wiring — the canonical `agent.slug` into
  `pome.json` and the gitignored `.pome/link.json` id cache — so the local
  run/doctor path resolves the agent and its transport. The MCP tool writes
  neither.
- **No local repo** (a Claude managed agent → `pome-intake` /
  `intake_clone_scope`, or a purely hosted registration with nothing on disk to
  link) → the MCP `register_agent`.

**If a paste-prompt or the builder spells out the CLI command, run it
verbatim.** Do not substitute the MCP `register_agent` "because it's the same
registration" — it is not. Registering a local repo agent through the MCP alone
leaves `.pome/link.json` unpopulated and the transport wrong, and a second
`pome register agent` is then needed to repair both (the 2026-07-24 cold-walk
regression, F-903).

Once an agent is registered, `register_agent(name, twins:[…])` from the run path
is still the right call for **additive twin enablement** on an
already-registered agent — it merges the allowlist (F-784), it is not a fresh
registration.

## This is not the CLI

The `pome` CLI records traces locally; evaluation and scoring are hosted. If
the builder arrives with the CLI mental model, map the verbs — tool names are
verbatim from the frozen control MCP contract v1.0:

| CLI-era habit | Hosted (coach) equivalent |
| --- | --- |
| `pome register agent` | **Not** a synonym for MCP `register_agent` — route by context (see **One register verb** above). A local repo keeps the CLI (it writes `pome.json` + `.pome/link.json` and sets local transport); only a no-repo / managed agent uses the MCP tool. |
| `pome run <task>` | `run_task` (mints the session) → launch the examinee → `finalize_run` the instant it idles → `get_report` |
| `pome run -n 3` (N trials) | `run_trials(n, task_id)` — the batch form that provisions all N under one shared `group_id` (or `run_task` ×N reusing one `group_id`); `finalize_run` each; `list_runs(group_id)` is the cross-run view |
| Local task files on disk | `save_task` into your team catalog on first use; browse with `list_tasks` (no cross-team library) |
| "Where are my results?" | `get_report(run_id)` / `list_runs`, and the dashboard on `app.pome.sh` |

Two standing facts to carry into every route: the examinee runs **closed-book**
(`web_search`/`web_fetch` disabled — seed the world instead of citing the live
internet), and tasks/examples ship as task **source** that gets `save_task`-ed
into the builder's own team on first run.
