# support-triage — local examinee

The hero example's **local examinee**: the same support-triage agent as
[`../agents/support-triage-v1.yaml`](../agents/support-triage-v1.yaml), but as a
minimal [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript)
process that runs on **your** machine instead of on a managed-agent platform. It
connects to Pome's GitHub + Slack twins over plain MCP (bearer-authenticated
streamable HTTP), works the task, and exits when done.

The exam it takes is the pack's task,
[`../tasks/duplicate-issue.md`](../tasks/duplicate-issue.md): a customer
re-reports a bug that open issue #1 already tracks.

## ⚠️ The baseline below does not fail. Measured, twice.

`DENY_ISSUE_LOOKUP = true` is **green**, on `claude-opus-5`, n=5 each, hosted:

| configuration | pass rate |
|---|---|
| as shipped 2026-08-04, open sandbox | 25 · 100 · 100 · 100 · 100 — **4/5** |
| sandbox closed (`tools: []`), denial unchanged | 100 × 5 — **5/5** |
| no denial at all, closed sandbox (the control) | 100 × 5 — **5/5** |

**No trial filed a duplicate** — the behaviour the whole lesson is built around.
Run ids and the routes the agent used are in
[`../VERIFICATION.md`](../VERIFICATION.md); the re-cut is
[F-1292](https://linear.app/pome-sh/issue/F-1292). Treat this folder as a working
local examinee with a **known-green** placeholder defect, not as a lesson.

## What the one line was supposed to do

The product story was meant to live in **one line** of committed configuration —
`DENY_ISSUE_LOOKUP` in [`src/index.ts`](./src/index.ts):

- **`true` (ships as the default — was expected to fail).** The agent's tool
  policy denies it three read paths into the repository's issues
  (`search_issues`, `list_issues`, `get_issue`). Its system prompt is the
  *correct* one — search before filing — so the theory was that it reaches for
  the lookup, is refused, honestly concludes nothing tracks the bug, and files a
  **duplicate**, scoring 33 rather than 0.
- **`false` (the one-line "fix").** The agent searches, finds issue #1, comments
  on it, and posts *its* link back.

What actually happens is that the agent reaches issue #1 anyway, through paths
the three names do not cover: `list_issue_comments` and `update_issue` (a write
that 404s on a missing issue), both used in **5 of 5** trials once the shell was
taken away. So the two variants produce the same behaviour and the same score.

It was filed as a **pattern-1** baseline in the curriculum's terms
(`pome-cloud docs/curriculum/failure-classes.md` §3) on the theory that a flaw in
the config layer cannot be rescued by a stronger model. The theory does not hold
for a *denial*: the model does not need to route around the denied tool, it only
needs any other tool that answers the same question. §3's own words, now earned:
a denial is only as strong as its enumeration.

The managed-agent pair next door (`../agents/support-triage-v1.yaml` vs
`…-v2.yaml`) tells the same fail → fix → pass story through a *prompt* flaw, on
a different runtime. That is a pattern-2 baseline and its red is
model-dependent; it is kept for the managed-agent path, but this file is the one
the curriculum grades.

## Telemetry

`query` is imported from `@pome-sh/adapter-claude-sdk`, not from
`@anthropic-ai/claude-agent-sdk`. It is a drop-in — the message stream is
byte-for-byte what the SDK yields — and it emits gen_ai OTLP spans (model,
per-turn input/output tokens, latency) whenever a runner injects
`POME_OTEL_EXPORTER_OTLP_ENDPOINT`, which both `pome run` and the coach do. With
no endpoint set it is inert, so a standalone run is unaffected.

Adopting it moved `@anthropic-ai/claude-agent-sdk` from a pinned `0.2.141` to
`^0.3.215` — the adapter's peer range, and the range
[`../../triage-agent`](../../triage-agent) already runs on. Nothing in this
examinee's SDK surface changed with it.

Using the adapter rather than hand-rolling the exporter is deliberate: per-turn
token accounting has two non-obvious traps the adapter already fixed — one API
turn arrives as several `assistant` messages that each repeat the same `usage`
object (naive counting over-reported one run's input by 79%), and the true
per-turn `output_tokens` only arrives on a `message_delta` stream event, not on
the assistant message. An example that re-implemented this would be teaching the
bug.

## How the coach launches it

This folder is built to be spawned as a **local subprocess** by the coach
(the agent driving the Pome control MCP at `mcp.pome.sh`):

1. **Fetch just this folder** onto the builder's machine:

   ```bash
   npx degit pome-sh/digital-twins/examples/support-triage/local support-triage-local
   cd support-triage-local && npm install
   ```

2. **Mint the run** — `run_task(task_id, agent_id, agent_version="v1")` seeds
   live twin sandboxes and returns `examinee_task` (the kickoff prompt) and
   `examinee_launch` (per-twin MCP URLs + the session bearer). Declare the
   version: after you swap in the fix below, the re-run declares `"v2"`, and
   that is what keeps the failing run and the fixed one from being read as one
   agent tried twice.

3. **Spawn with the env contract** — map the spec onto the env and start the
   process:

   | env var | from `run_task` |
   | --- | --- |
   | `POME_GITHUB_MCP_URL` | `examinee_launch` — the GitHub twin's per-session MCP URL |
   | `POME_SLACK_MCP_URL` | `examinee_launch` — the Slack twin's per-session MCP URL |
   | `POME_AUTH_TOKEN` | `agent_token` — the session bearer for **both** twins. **Sensitive**: env-inject only, never write it to disk |
   | `POME_TASK` | `examinee_task.prompt` (optional — the bundled kickoff prompt is the fallback) |

   ```bash
   POME_GITHUB_MCP_URL=… POME_SLACK_MCP_URL=… POME_AUTH_TOKEN=… POME_TASK=… npm run start
   ```

4. **Finalize on exit** — the process exits when the agent is done; the coach
   calls `finalize_run(session_id, agent_token)` the instant it does, while the
   twin session is still live, then narrates `get_report`.

The same env contract is what the Pome CLI injects, so the local loop also
works without the coach — from this directory, with the CLI at `../../../cli`:

```bash
npm run --cwd ../../../cli dev -- run ../examples/support-triage/tasks/duplicate-issue.md \
  --agent "npm run --cwd $(pwd) start"
```

## Zero-key Claude auth

The Agent SDK needs Claude auth, nothing else:

- a **stored `claude` login** on this machine (subscription — no env var at
  all), or
- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or
- `ANTHROPIC_API_KEY` as the BYOK fallback.

The twin side is zero-key by construction: the only credential is the
per-session bearer the runner injects as `POME_AUTH_TOKEN`.

## Layout

```
src/index.ts             the examinee — env wiring, the DENY_ISSUE_LOOKUP defect, the SDK loop
test/env.test.ts         unit test for the launch env contract (npm test)
test/tool-policy.test.ts two properties — the deny-list's branches, and the closed sandbox
```

### The closed sandbox

`options.tools: []` gives the model **no SDK built-in at all** — no `Bash`,
`Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch` or `WebFetch`. Only the two
twins' MCP tools reach it, because those come from `mcpServers` rather than from
the built-in set (verified from the SDK's `init` message: 100 tools, all
`mcp__*`).

This is an **allowlist**, deliberately, rather than more names in
`disallowedTools`. Until 2026-08-05 every built-in was live, and one measured
trial in five used `Bash` to `cat` this examinee's own source and identify the
fixture — with `../tasks/duplicate-issue.md`, which carries all four grading
criteria and the complete seed state, one directory away. An examinee that can
read its own criteria is not sitting an exam.

Note that `allowedTools` would **not** have closed it: it only auto-approves and
does not restrict. Measured — `allowedTools` naming a single MCP tool left 152
tools live, `Bash` and `Read` among them.

`npm run typecheck` type-checks; `npm test` runs the env-contract test. This
package is intentionally **not** part of the root npm workspace — install and
run it standalone.
