# support-triage — a self-fix demo on Pome

A minimal **support-triage agent** for the `acme` engineering org: it watches the
`#support` Slack channel for bug reports, reproduces them, tracks each as a GitHub
issue in `acme/orders-service`, and posts the tracking link back to `#support`.
Two twins in one run — the **Slack twin** (where the report arrives) and the
**GitHub twin** (where the issue lives).

The pack exists to demo a reproducible **FAIL → FIX → PASS** on Pome, and it does
it on **two runtimes**. The graded one — curriculum lesson #1 — is the local
examinee, whose flaw is a committed tool-policy defect; jump to
[the lesson](#lesson-the-agent-that-could-not-look-before-it-leapt).

The managed-agent path tells the same story through a pair of prompts that differ
by exactly **one line**:

- `agents/support-triage-v1.yaml` — **baseline**. Its charter tells the agent
  *not* to search existing issues. On a re-reported bug it files a **duplicate**
  issue. **Fails.**
- `agents/support-triage-v2.yaml` — **fixed**. The one line is replaced by a
  *search-before-filing* rule, so it comments on the existing issue instead of
  opening a second one. **Passes.**

```bash
diff agents/support-triage-v1.yaml agents/support-triage-v2.yaml   # one line
```

The failure — filing a duplicate issue for a bug that's already tracked — is the
kind of thing a happy-path demo never shows and an issue tracker hates at scale.
Pome catches it by grading the twin's real end state: `issues: 1 → 2` (a
duplicate) for v1 vs `issues: 1 → 1` + a comment for v2. Measured results are in
[`VERIFICATION.md`](./VERIFICATION.md) (v1 **0/5**, v2 **4/5** on
`claude-sonnet-5`).

## The task

[`tasks/duplicate-issue.md`](./tasks/duplicate-issue.md) is
self-contained (task + criteria + an inline `## Seed State`). The seed pre-loads
open issue #1 for the coupon bug, then `#support` receives a *new* report of the
*same* bug. A good agent recognizes the duplicate.

| criterion | kind | checks |
|---|---|---|
| a `#support` message links `issues/1` | code:slack | the agent linked the *existing* issue, not a new one |
| no new issues in `acme/orders-service` | code:github | **the lesson itself** — a duplicate was not filed |
| commented on issue #1 | model | the report was attached to the existing issue |
| concrete repro steps | model | quality of the tracked report |

The dedup decision used to be graded by the judge alone, which made it possible
to link `issues/1` *and* file a duplicate and still score 100 — the exact
necessary-but-not-sufficient hole `docs/curriculum/failure-classes.md` §4.2 warns
about. `github.no-new-issues` closes it: the state claim is `[code]`, and the
judge is left grading text, which is all §4.3 ever wanted from it.

## Run it against Pome

The two versions are **one agent at two declared versions**, so the dashboard
can show the v1→v2 delta rather than two unrelated identities with no
relationship between them.

1. **Register on Cloud Managed Agents** — create each agent from its YAML on
   Anthropic's Managed Agents platform (`ant beta:agents create`, model
   `claude-sonnet-5`).
2. **Register on Pome** (control MCP) — once. The version is not part of the
   identity; it is declared per run in step 3:
   ```
   register_agent(name="support-triage", twins=["github","slack"])
   ```
3. **Run** — `run_trials(task_id, agent_id, agent_version="v1", n=5)`, then the
   same call with `agent_version="v2"`. Each trial returns an `examinee_launch`
   spec (per-session twin MCP URLs, a bearer, `always_allow`, a
   `network.mode: limited` clamp, web tools off). Assemble the examinee clone
   from that spec (mirrors
   `pome-run-task/references/launch-managed-agent.md`), give it
   `examinee_task.prompt`, and let it work.
4. **Finalize** — `finalize_run(session_id, agent_token)` the instant the
   examinee idles (the tape is pulled from the still-live twin session), then
   `get_report` for the score. Tear the clone down afterward — clones are
   ephemeral, one per trial.

The self-fix loop is the swap between step 3's two versions: run v1 → watch it
fail by filing a duplicate → re-run as v2 (the one-line fix) → watch it pass.
Declare the version on **both** runs. Run-sets are partitioned by
`(agent, task, agent_version)`, so two runs under one label are read as one
agent tried twice — and the v1→v2 improvement gets reported as that agent
being unreliable. Pass the v1 run's `group_id` as the v2 run's
`baseline_group_id` and the report pairs them into a fail→green comparison.

## Lesson: the agent that could not look before it leapt

This is the curriculum's **lesson #1**, and the graded baseline lives in
[`src/index.ts`](./src/index.ts) — the same agent as a Claude Agent SDK process
on your machine. The one line under test is `DENY_ISSUE_LOOKUP`, right there.

> **Two runtimes, one story, two different flaws.** The `agents/*.yaml` pair
> above tells this story on Anthropic's Managed Agents platform through a
> *prompt* flaw — a charter line telling the agent not to search. That is a
> **pattern-2** baseline (`pome-cloud docs/curriculum/failure-classes.md` §3):
> legitimate, but its red is model-dependent. The local examinee is the
> **pattern-1** version and it is the one the curriculum grades. Both are kept
> because the pair is genuinely useful for the managed-agent path; only one is
> the lesson.

### What breaks

A customer re-reports a bug that open issue #1 in `acme/orders-service` already
tracks. The agent's instructions are **correct** — *search the open issues first;
only open a new one if nothing already tracks the bug* — and it follows them. It
reaches for the lookup and is refused, because the examinee's committed tool
policy denies every read path into the repository's issues:

```ts
const ISSUE_LOOKUP_TOOLS = [
  "mcp__github__search_issues",
  "mcp__github__list_issues",
  "mcp__github__get_issue",
];
const DENY_ISSUE_LOOKUP = true;   // ← ships as the baseline
```

So it concludes, honestly and wrongly, that the bug is untracked — and files a
second issue for it. **The agent did nothing wrong.** Its context was corrupted
before it ever reasoned.

Two properties make this worth a lesson rather than a bug report:

* ~~**It cannot rot green** (§3, pattern 1).~~ **This claim was measured false
  on 2026-08-04** and is kept struck through rather than deleted, because the
  reasoning error is the lesson. The argument was: *no model capability can call
  a tool that was never exposed*. True, and beside the point — the model never
  needed the denied tool. It built the read out of an allowed **write**
  (`update_issue` 404s on a missing issue) and out of the SDK's **shell**. A
  denial is only as strong as the enumeration behind it.
* **It is the most common real version of this bug.** Over-restrictive tool
  allowlists are a production default. Nobody writes "don't dedup" in a system
  prompt; plenty of people ship an agent that cannot see what it needs to.

### Run the failing baseline

The defect ships as the default, so the failing run is the plain one:

```bash
pome run tasks/duplicate-issue.md -n 5
```

`runs: 5` is in the task config on purpose — the report teaches **pass^k**, and
one trial proves nothing.

> ⚠️ **NOT verified red — measured 2026-08-04 and it PASSED 4 of 5.**
> `claude-opus-5`, n=5, hosted: `25 · 100 · 100 · 100 · 100`. No trial filed a
> duplicate. Four reached issue #1 anyway — one route was `update_issue` used as
> an existence oracle, the other was the SDK's shell reading the fixture out of
> this very file's neighbours. The numbers, the run ids and both routes are in
> [`VERIFICATION.md`](./VERIFICATION.md); the re-cut is pending.
>
> **Everything in the three sections below describes the baseline as designed,
> not as it behaves.** Read them as the intent under repair.

### Read the report

The pivotal criterion is the `#support` message linking `issues/1`. Under the
baseline the agent links `issues/2` — the one it just created — so the criterion
fails on a deterministic state read rather than a judge's opinion, and the
state-diff panel shows `issues: 1 → 2`.

The span waterfall shows the rest of the story, and it is the part that makes the
diagnosis fast: a `search_issues` tool span that returns a refusal, followed by
`create_issue`. The agent tried.

### The fix

One line in [`src/index.ts`](./src/index.ts):

```diff
-const DENY_ISSUE_LOOKUP = true;
+const DENY_ISSUE_LOOKUP = false;
```

### Re-run green

```bash
pome run tasks/duplicate-issue.md -n 5
```

The agent searches, finds issue #1, comments on it, and posts *its* link back to
`#support`. State-diff: `issues: 1 → 1` plus a comment.

### Customize

* **Deny one tool instead of three.** Leave `list_issues` reachable and watch the
  agent route around the defect — a useful demonstration that a partial denial is
  not a defect at all, and why the baseline names every read path.
* **Move the flaw to the write side.** Deny `add_issue_comment` instead: now the
  agent *finds* the duplicate and still cannot do the right thing, which is a
  different failure with the same symptom. Worth running once to see how much the
  report distinguishes them.

### If your baseline passes / your fix fails

* **Baseline passes (stays green).** It does — 4/5 open-book, 5/5 with the
  sandbox closed. This section used to say the fix is to add the missing read
  path to `ISSUE_LOOKUP_TOOLS`. **That advice was measured wrong and is
  withdrawn.** Shutting the first three paths surfaced two more the same
  afternoon — `list_issue_comments` and `update_issue` — and the twin's read
  surface is wide enough that the next pass would surface more. Do not extend the
  list; the flaw has to stop being a denial (numbers in
  [`VERIFICATION.md`](./VERIFICATION.md)).
* **Fix fails (stays red).** If a criterion reads `NOT EVALUATED` rather than
  failed, the run is `INCOMPLETE` — the grader could not see that state at all,
  which is a wiring problem rather than an agent problem. `pome run` exits 1 on
  that too, and the score names its own denominator. If the `[model]` criteria
  are the red ones, raise `-n`: one clean set is a signal, not proof.

### Known gap in the criteria

The criteria above assert that the agent **linked the right issue**. They do not
yet assert that it **opened no second one** — a negative assertion the declared
GitHub vocabulary could not express until `github.no-new-issues` existed. Until
that check reaches the cloud's pin, an agent that comments on #1, posts the link
*and also* files a duplicate passes. Said out loud here rather than left for a
reader to discover, because this example is the one that defines the standard.

## Local examinee

[`src/index.ts`](./src/index.ts) is the same agent as a minimal **Claude Agent
SDK process on your machine** — no managed-agent platform needed. The coach
spawns it as a subprocess after `run_task` (per-twin MCP URLs + bearer arrive
via env), it works the task over MCP, and exits when done.

> **⚠️ The baseline below does not fail. Measured, twice.**
> `DENY_ISSUE_LOOKUP = true` is **green**, on `claude-opus-5`, n=5 each, hosted:
>
> | configuration | pass rate |
> |---|---|
> | as shipped 2026-08-04, open sandbox | 25 · 100 · 100 · 100 · 100 — **4/5** |
> | sandbox closed (`tools: []`), denial unchanged | 100 × 5 — **5/5** |
> | no denial at all, closed sandbox (the control) | 100 × 5 — **5/5** |
>
> **No trial filed a duplicate** — the behaviour the whole lesson is built
> around. Run ids and the routes the agent used are in
> [`VERIFICATION.md`](./VERIFICATION.md); the re-cut is pending. Treat this
> example as a working local examinee with a **known-green** placeholder defect,
> not as a lesson, until that re-cut lands.

### Telemetry

`query` is imported from `@pome-sh/adapter-claude-sdk`, not from
`@anthropic-ai/claude-agent-sdk`. It is a drop-in — the message stream is
byte-for-byte what the SDK yields — and it emits gen_ai OTLP spans (model,
per-turn input/output tokens, latency) whenever a runner injects
`POME_OTEL_EXPORTER_OTLP_ENDPOINT`, which both `pome run` and the coach do. With
no endpoint set it is inert, so a standalone run is unaffected.

Using the adapter rather than hand-rolling the exporter is deliberate: per-turn
token accounting has two non-obvious traps the adapter already fixed — one API
turn arrives as several `assistant` messages that each repeat the same `usage`
object (naive counting over-reported one run's input by 79%), and the true
per-turn `output_tokens` only arrives on a `message_delta` stream event, not on
the assistant message. An example that re-implemented this would be teaching the
bug.

### How the coach launches it

This example is built to be spawned as a **local subprocess** by the coach
(the agent driving the Pome control MCP at `mcp.pome.sh`):

1. **Fetch just this folder** onto the builder's machine:

   ```bash
   npx degit pome-sh/digital-twins/agent-examples/support-triage support-triage-local
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
works without the coach, from this directory:

```bash
pome run tasks/duplicate-issue.md --agent "npm run start"
```

### Zero-key Claude auth

The Agent SDK needs Claude auth, nothing else:

- a **stored `claude` login** on this machine (subscription — no env var at
  all), or
- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or
- `ANTHROPIC_API_KEY` as the BYOK fallback.

The twin side is zero-key by construction: the only credential is the
per-session bearer the runner injects as `POME_AUTH_TOKEN`.

### The closed sandbox

`options.tools: []` gives the model **no SDK built-in at all** — no `Bash`,
`Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch` or `WebFetch`. Only the two
twins' MCP tools reach it, because those come from `mcpServers` rather than from
the built-in set (verified from the SDK's `init` message: 100 tools, all
`mcp__*`).

This is an **allowlist**, deliberately, rather than more names in
`disallowedTools`. Until 2026-08-05 every built-in was live, and one measured
trial in five used `Bash` to `cat` this examinee's own source and identify the
fixture — with `tasks/duplicate-issue.md`, which carries all four grading
criteria and the complete seed state, in the examinee's own working directory
since the flatten (it was one level up before). An examinee that can read its
own criteria is not sitting an exam, and `tools: []` is now the *only* thing
standing between it and the answer key — re-enable `Read` or `Bash` for a
debugging session and the criteria are one unqualified filename away.

Note that `allowedTools` would **not** have closed it: it only auto-approves and
does not restrict. Measured — `allowedTools` naming a single MCP tool left 152
tools live, `Bash` and `Read` among them.

### The other door: `settingSources: []`

`tools` is only half of it, and the half that is easy to mistake for the whole.
It governs the SDK's **built-in** set. `options.settingSources` governs
**filesystem settings** — user (`~/.claude/settings.json`), project
(`.claude/settings.json`) and local (`.claude/settings.local.json`) — and those
carry the **Claude Code plugin MCP servers configured on whoever's machine this
runs on**. Omit the option and the SDK loads all three ("matches CLI defaults");
`[]` is its documented isolation mode.

Measured 2026-08-05, on a `claude-haiku-4-5` trial of this very task with
`tools: []` **already set**: the examinee called
`mcp__plugin_slack_slack__slack_search_channels`, `…__slack_search_public` and
`…__slack_list_channel_members`. It searched the *developer's real Slack
workspace*, made zero twin calls, and would have scored as *the agent failed to
triage* — a verdict about the wrong workspace entirely. With `settingSources: []`
the same trial called only `mcp__github__*` / `mcp__slack__*`, searched issues
first, commented on #1, posted the link, and scored 75.

This is the one exam surface that changes depending on **who runs it**, which is
why it is not left to intention: `scripts/check-example-sdk-isolation.mjs` in
this repo's CI fails any bundled Claude-Agent-SDK example whose `query()`
options omit either door.

`npm run typecheck` type-checks; `npm test` runs the env-contract and
tool-policy tests.

## Layout

```
pome.json                       committed manifest: agent.slug + framework + tasks dir
agents/support-triage-v1.yaml   managed-agent baseline (prompt flaw, pattern 2)
agents/support-triage-v2.yaml   managed-agent fix; one line different
tasks/duplicate-issue.md        the task (inline ## Seed State)
src/index.ts                    the graded examinee — the pattern-1 baseline lives here
test/tool-policy.test.ts        the lesson pinned as a property (both branches)
test/env.test.ts                unit test for the launch env contract
VERIFICATION.md                 measured results, and what each measurement was of
```

Two runtimes, one layout: `agents/*.yaml` is the managed-agent pair (Anthropic's
platform runs it directly from the YAML); `src/` plus `package.json` is the
local examinee, a standalone Node package you `npm install` and `npm start` in
this same directory — no nested subfolder. It keeps its **own lockfile** and is
deliberately **not** a member of the root npm workspace, like every other
example: install and run it from this directory, not from the repo root.

## Notes

- The bearer token in each `examinee_launch` is **sensitive** — keep it in memory
  only; never write it to disk or into a task.
- The declared `mcp_servers` URLs (`mcp.slack.com`, `api.githubcopilot.com`) are
  the agent's *real* servers; Pome swaps them for per-session twin URLs at run
  time. Do not intake `support-triage-v1` against a real deployment — it files
  duplicates by design.
