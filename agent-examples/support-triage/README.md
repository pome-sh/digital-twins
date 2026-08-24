# support-triage — a self-fix demo on Pome

A minimal **support-triage agent** for the `acme` engineering org: it watches the
`#support` Slack channel for bug reports, reproduces them, tracks each as a GitHub
issue in `acme/orders-service`, and posts the tracking link back to `#support`.
Two twins in one run — the **Slack twin** (where the report arrives) and the
**GitHub twin** (where the issue lives).

The pack exists to demo a reproducible **FAIL → FIX → PASS** on Pome, and it does
it on **two runtimes**. The graded one — curriculum lesson #1 — is the local
examinee, and its difficulty lives in the **seeded world**, not in a planted
agent defect: jump to
[the lesson](#lesson-the-agent-that-never-asked-what-the-teams-convention-was).

The managed-agent path tells the **same** story through a pair of prompts that
differ by exactly **one line**:

- `agents/support-triage-v1.yaml` — **baseline**. A competent triage agent: it is
  told to search before filing, and it does. What it has never been told is that
  `acme/orders-service` consolidates recurring reports onto **tracking issues** —
  a convention written down in the repository and named in no prompt. So it
  routes the report to the issue that textually matches, which is the wrong one.
  **Fails.**
- `agents/support-triage-v2.yaml` — **fixed**. One sentence pointing at the
  repository's own rules. **Passes.**

```bash
diff agents/support-triage-v1.yaml agents/support-triage-v2.yaml   # one line
```

That one line is the same sentence the local examinee adds behind
`POME_TRIAGE_POLICY_HINT=on`, and `test/example.test.ts` pins the two together —
the two runtimes are one experiment, not two demos that resemble each other.

**The baseline is not sabotaged.** Nothing in v1 is wrong in general; it is
incomplete about one org's rules, which is the honest state of most production
triage agents. That makes the demo `unreliable → reliable` rather than
`broken → fixed`, and the difficulty lives in the **seeded world** rather than in
a planted defect — which is the whole reason this is curriculum lesson #1.

Measured on the local examinee, 5 trials per arm, one task fingerprint, one twin
snapshot, one examinee commit. The only difference between the two rows is an env
switch:

| model | baseline — naive | fixed — one sentence added |
|---|---|---|
| **`claude-haiku-4-5`** (what this walk uses) | **0 / 5** — 50 · 67 · 25 · 25 · 25 | **5 / 5** — 100 ×5 |
| `claude-sonnet-5` | 1 / 5 | 5 / 5 |
| `claude-opus-5` | 5 / 5 | — nothing to repair |

**Every point on this page comes from the twin — its recorded call tape and its
final state. No LLM judge takes part in this task's verdict.** All five criteria
are deterministic `[code]` checks; the task declares zero `[model]` criteria, and
`cli/test/golden/support-triage-gate.test.ts` pins that at zero so a judge cannot
quietly re-enter the pass/fail boundary. (There *was* a sixth, `[model]`
criterion. It was removed for cause — see
[`VERIFICATION.md`](./VERIFICATION.md).)

Run the walk on **haiku**: it is the cleanest flip (0/5 → 5/5, no ambiguous
partial pass), the cheapest, and the fastest. The sonnet row is the more
interesting failure and is worth reading about below. On opus the baseline simply
passes, so there is nothing to demonstrate.

## The task

[`tasks/duplicate-issue.md`](./tasks/duplicate-issue.md) is
self-contained (task + criteria + an inline `## Seed State`). `#support` receives
a new report of a bug the repository already tracks — but **the issue that
textually matches the report is not the one the report belongs on.**

`acme/orders-service` runs a consolidated-tracking convention, written down in
`docs/triage-policy.md` inside the seeded repo and named in no prompt:

* **#47** — *"POST /orders returns 500 when the coupon field is empty"* — open,
  labelled `bug`, a word-for-word match for the report. Every default a triage
  agent carries points here. It is **not** the answer.
* **#23** — *"[tracking] Coupon-path regressions"* — carries the `tracking` label
  and consolidates #47 and #31. The policy says new occurrences are recorded
  here, that the comment must name the consolidated issue by number, and that the
  link sent back to the reporter is this one's.

Three more open issues (#8, #31, #52) mean listing the issues does not hand over
a one-item answer.

| criterion | kind | checks |
|---|---|---|
| a comment containing `#47` exists on issue #23 | code:github | routed to the tracking issue, and cited the consolidated one |
| a `#support` message contains `issues/23` | code:slack | the reporter got the link the policy names |
| **no message anywhere contains `issues/47`** | code:slack | **the wrong-value guard** — this is what an agent that skipped the policy sends |
| no new issues in `acme/orders-service` | code:github | the original restraint lesson — a duplicate was not filed |
| `add_issue_comment` was called | code:github | a do-nothing agent cannot clear the github side |

All five are `[code]`. The third is AutomationBench's
**negative-assertion-bound-to-the-wrong-value** technique: beside asserting the
right answer, assert the object does not hold the specific wrong value this
task's failure mode produces. It separates *did it right* from *did the known
wrong thing*, deterministically, which no judge can do reliably.

**A sixth criterion used to sit here** — a `[model]` judge call on whether the
comment carried the customer's repro. It is gone, and the reason is the sharpest
lesson in this example about writing criteria: across **25** measured trials it
passed **every single time, including on runs that commented on the wrong
issue**. Its sentence — *"the report the agent added contains concrete repro
steps"* — never named which issue the report had to be on, so a well-written
comment in the wrong place satisfied it. That is a **free assertion**: it cannot
fail, so it measures nothing, and on a failing run it was worth a free 20 points.
Removing it widened the gap (a routed-to-#47 run went 40 → 25) and took the last
non-deterministic thing out of the verdict.

Two criteria (`issues/47`, `no-new-issues`) already hold on the seed. The
grader excludes a seed-true criterion from the denominator **only when it also
holds at finish**, so on a run that respects them they drop out, and on a run
that breaks them they are **counted as failures**. That asymmetry is deliberate and is what
keeps a do-nothing agent at 0 — see `VERIFICATION.md` before adding an
`always-scored` marker to either.

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

## Lesson: the agent that never asked what the team's convention was

This is the curriculum's **lesson #1**. The graded examinee lives in
[`src/index.ts`](./src/index.ts) — the same agent as a Claude Agent SDK process
on your machine — and it carries **no planted defect at all**.

> **The defect used to live here, and it was retired for cause.** Until
> 2026-08-21 this example shipped a committed tool denial (`DENY_ISSUE_LOOKUP`)
> that was supposed to make the agent unable to find the existing issue. It was
> measured green four separate ways: 4/5 with the sandbox open, **5/5 with the
> sandbox sealed** (the agent found two more read paths the deny-list never
> named), 5/5 with the denial removed entirely, and 5/5 with the search-first
> rule deleted from the prompt. That last one is the one that settled it — the
> sentence the whole lesson rested on has no measurable effect on
> `claude-opus-5` here, because it searches by reflex. All the numbers and run
> ids are in [`VERIFICATION.md`](./VERIFICATION.md).
>
> `DENY_ISSUE_LOOKUP` still exists and still ships `false`, because the web
> clamp (`WebSearch`/`WebFetch`) rides the same function. **Do not flip it back
> to `true` expecting a red** — you will get a 5/5 and a false story.

### What breaks

The agent's instructions are correct and it follows them. It reads the report,
searches the open issues, and finds **#47** — *"POST /orders returns 500 when the
coupon field is empty"* — which matches the customer's words almost exactly. It
comments there and sends that link back to `#support`.

That is the wrong answer, and nothing at run time tells it so. `acme/orders-service`
consolidates coupon-path regressions onto tracking issue **#23**, and the rule
lives in `docs/triage-policy.md` in the repository. The agent was never told the
file exists.

Two properties make this worth a lesson rather than a trick:

* **It is a written rule against an unwritten default.** The
  [difficulty ladder](../minimal-viktor/) measured this over 19 hosted trials and
  four models: the lowest rung that actually discriminates is a policy the agent
  must find, conflicting with a habit it already has. Two *written* rules with a
  stated precedence were resolved correctly in all 19 trials — models are good at
  precedence lists. They are much worse at suspecting a convention exists.
* **No capability was removed.** The agent has `search_code`, `get_file_contents`
  and every read path into the issues. It can reach the policy file from the
  first turn. Nothing refuses it, so there is nothing to notice and route around —
  which is exactly what defeated the previous baseline.

### Run the failing baseline

The naive agent ships as the default, so the failing run is the plain one:

```bash
ANTHROPIC_MODEL=claude-haiku-4-5 pome run tasks/duplicate-issue.md -n 5
```

Two things in that line are deliberate. `runs: 5` is in the task config because
the report teaches **pass^k** and one trial proves nothing. And the model is
**pinned**, because which model you run is part of the experiment, not a detail —
see the table below.

> **`verified red: claude-haiku-4-5 5/5, 2026-08-23`** — 5 hosted trials against
> this exact file, one fingerprint, one twin snapshot:
>
> | model | n | scores | fails |
> |---|---|---|---|
> | `claude-haiku-4-5` | 5 | 50 · 67 · 25 · 25 · 25 | **5 / 5** |
>
> Run ids are in the `## Discrimination` section of the task file. Every score
> there is a count of deterministic checks against twin state — no judge.
>
> **On `claude-opus-5` this task is GREEN, 5 of 5, and that is measured rather
> than suspected**: opus fetches `docs/triage-policy.md` by name, unprompted, in
> every trial. The prediction committed before that run said 2 of 5. It was
> wrong. Run the failing baseline on haiku or sonnet, not on opus.
>
> **Two earlier tables are superseded**, and both are kept in
> [`VERIFICATION.md`](./VERIFICATION.md) because why they were wrong is the
> durable part. The 2026-08-21 set was taken through two twin defects — a
> `list_issues` 422 on the array its own MCP schema declares, and a
> whole-string `search_issues` match returning empty — which manufactured
> failures the agent did not commit. The 2026-08-22 set is clean but was scored
> with the sixth, `[model]` criterion still in the denominator, so its numbers
> are 15 points higher on a failing run than they would be today.

### Read the report

Two criteria carry the diagnosis, and they fail in different places:

* `A comment containing "#47" exists on issue #23` fails on a deterministic state
  read — the state-diff panel shows the comment landed on #47 instead.
* `No message containing "issues/47" appears in any public channel` fails on what
  the agent *told the reporter*. This is the wrong-value guard, and it is the one
  that distinguishes "did the right thing" from "did the known wrong thing".

The span waterfall shows the rest, and **three different failures live in it** —
worth telling apart, because they call for different fixes:

* **Never looked, wrong destination.** `list_issues`, then straight to
  `add_issue_comment` on #47, with no `get_file_contents` on `docs/` anywhere in
  between. Three of haiku's five. Attention, not judgment: new obligations
  displace search.
* **Never looked, right destination anyway.** Two of haiku's five commented on
  **#23** without ever opening the policy — they inferred it from the tracking
  issue's own body, which names the file. **Both still failed**, because neither
  named #47 in the comment and both put `issues/47` in front of the reporter.
  This is the one worth staring at: the agent arrived at the right place by luck
  and the criteria did not give it credit. Getting the destination right is not
  the same as following the rule, and a looser criterion would have scored these
  as wins.
* **Looked, and overruled it.** `get_file_contents` on `docs/triage-policy.md`
  *is* in the waterfall — and the comment still lands on #47. This is three of
  `claude-sonnet-5`'s four failures, and it is the most interesting: the agent's
  own standing instruction (*comment on the existing issue and post ITS link*)
  outranked the rule it had just read.

So when you read your own report, check the waterfall for the policy fetch before
concluding the agent could not find the rule. If the fetch is there, the fix is
not about discoverability.

### The fix

One line, and it is the repair a builder would actually make — tell the agent
where its team's rules live:

```bash
POME_TRIAGE_POLICY_HINT=on ANTHROPIC_MODEL=claude-haiku-4-5 \
  pome run tasks/duplicate-issue.md -n 5
```

which appends one sentence to the system prompt
([`src/index.ts`](./src/index.ts), `policyHint()`):

> Before you comment on an issue or send anyone a link, read
> `docs/triage-policy.md` in the repository and follow its routing rules.

It is an env switch rather than a committed edit so both arms run from one
commit — two numbers measured against two different trees are not comparable.

**This is not un-planting a fixture.** The baseline agent is not sabotaged, it is
naive, which is the honest state of most production triage agents. The demo is
`unreliable → reliable`, which `docs/curriculum/failure-classes.md` §2 Premise C
says is the shape that endures, rather than `broken → fixed`.

### Re-run green

**5 of 5, every criterion, on the same fingerprint and the same twin snapshot as
the baseline** — measured 2026-08-23, `claude-haiku-4-5`, run ids in the task
file's `## Discrimination` section. The agent reads the policy, routes the report
to **#23**, names **#47** in the comment, and sends #23's link back to `#support`.

**0 / 5 → 5 / 5.** Same fingerprint, same snapshot, same examinee commit; one env
variable is the entire difference.

The interesting part is *what* moved, and it is not what the fix looks like it
does. "Point the agent at the policy file" reads as a discoverability aid. On
haiku that is half true — 0 of 5 naive trials opened the file, 5 of 5 fixed ones
did. But on `claude-sonnet-5`, **three of four naive failures had already read
it** and routed to #47 anyway, because the agent's own standing instruction
(*comment on the existing issue and post ITS link*) outranked the rule it had
just fetched.

That is the general mechanism, and it is worth carrying to your own agent: a file
the agent reads is **data**; its system prompt is **instruction**; and a model
correctly ranks instruction above data — otherwise anything it read could
hijack it. So naming the file in the charter is not teaching it where to look. It
is **transferring authority** to that file. If you want your agent to obey your
team's written conventions, you have to say so; it will not assume a document it
found outranks you.

That is also why the score jumps rather than drifts: `passThreshold` is 100, so a
run that routes to #47 scores 25 and fails outright. There is no partial credit
to climb through.

### Customize

* **Move the policy.** Put the rule in the repo's `README.md` instead of
  `docs/triage-policy.md` and re-measure. This isolates *"ambiguity of where the
  information lives"* — the one AutomationBench hardening lever the difficulty
  ladder could not test, because minimal-viktor has no search tool and this
  example does.
* **Rename the tracking label.** `tracking` is a word a model may already
  associate with the right behaviour. Try a house-specific one (`rollup`,
  `parent`) and see whether the rule still transfers, or whether the previous
  number was partly vocabulary luck.
* **Delete the distractors.** Drop #8, #31 and #52 and re-measure to see how much
  of the difficulty was the search space rather than the policy.

### If your baseline passes / your fix fails

* **Baseline passes (stays green).** On `claude-opus-5` it does, every time, and
  that is measured rather than suspected — it reads the policy file by reflex. Run
  the baseline on `claude-haiku-4-5` (0/5) or `claude-sonnet-5` (1/5) instead. If
  you need a red on opus specifically, the designed fallback is in
  [`VERIFICATION.md`](./VERIFICATION.md): the same world plus a committed
  pattern-1 config defect (a context-file path that does not resolve), so the
  policy never reaches the model. **Do not** reach for a tool denial — that route
  is measured dead.
* **Fix fails (stays red).** If a criterion reads `NOT EVALUATED` rather than
  failed, the run is `INCOMPLETE` — the grader could not see that state at all,
  which is a wiring problem rather than an agent problem. `pome run` exits 1 on
  that too, and the score names its own denominator. Note that this task has no
  `[model]` criteria at all, so a red here is never judge variance — it is a fact
  about the twin's final state or its call tape, and the report names which.

### Why this task has no judge in it

The five `[code]` criteria are deterministic and, on this task, settled: the
restraint half that used to be missing landed as `github.no-new-issues`, and the
wrong-value guard as `slack.no-message-containing`. All five bind, and all five were graded in every
trial reported on this page.

There used to be a sixth, `[model]` criterion, and **two independent things were
wrong with it**. Both are worth knowing before you write your own.

**1. It could not fail.** *"The report the agent added contains concrete repro
steps drawn from the customer's message"* does not say **which issue** the report
has to be on. So an agent that wrote an excellent comment on the *wrong* issue
satisfied it. Across 25 measured trials — three models, both arms, including runs
that failed every other criterion — it passed every time. A criterion that cannot
fail is not lenient, it is **inert**: it measures nothing and inflates the
denominator. AutomationBench calls this a *free assertion* and excludes the class;
we copied the technique and then shipped one anyway. Worth 20 points to every
failing run until it was removed.

**2. When it *can* fail, it is inconsistent.** Its sentence has a premise — that a
report exists at all. Measured on three byte-identical trials where the agent
created an issue and added no comment, the judge twice substituted the new
issue's body and PASSED, once correctly said the premise was unmet and FAILED.
**20 points of variance from the grader alone**, on a task whose `passThreshold`
is 100. `[code]` has a settled contract for the absent-subject case
(`NOT EVALUATED`); `[model]` has none, and that gap is open.

Note that these pull in opposite directions, which is why fixing the wording
would not have been enough: binding the criterion to #23 would make it able to
fail, and would walk it straight into the variance in (2). The right move on a
task whose whole point is a deterministic verdict was to remove it.

**The rule this example now follows, and recommends:** a `[model]` criterion is
for things no check can express, it belongs on tasks where you want a
*qualitative* read, and it should never be the thing carrying a pass/fail
boundary. Said out loud rather than left for a reader to discover, because this
example is the one that defines the standard.

## Local examinee

[`src/index.ts`](./src/index.ts) is the same agent as a minimal **Claude Agent
SDK process on your machine** — no managed-agent platform needed. The coach
spawns it as a subprocess after `run_task` (per-twin MCP URLs + bearer arrive
via env), it works the task over MCP, and exits when done.

> **⚠️ The difficulty is in the world now, and it has not been measured yet.**
> This examinee carries no planted defect. Every attempt to put one *here* was
> measured green on `claude-opus-5`, n=5 each, hosted:
>
> | configuration | pass rate |
> |---|---|
> | tool denial as shipped 2026-08-04, open sandbox | 25 · 100 · 100 · 100 · 100 — **4/5** |
> | sandbox closed (`tools: []`), denial unchanged | 100 × 5 — **5/5** |
> | no denial at all, closed sandbox (the control) | 100 × 5 — **5/5** |
> | search-first rule deleted from the prompt | 100 × 5 — **5/5** |
>
> The last row is why the prompt is not the lever either. The re-cut moved the
> difficulty into the seeded world (2026-08-21), its prediction was committed in
> [`VERIFICATION.md`](./VERIFICATION.md) **ahead of the run**, and the run has
> since been taken on both arms — 0/5 → 5/5. The lesson is measured, not
> designed.

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
why it is not left to intention: `scripts/lint/rules/example-isolation.mjs` in
this repo's CI fails any bundled Claude-Agent-SDK example whose `query()`
options omit either door.

`npm run typecheck` type-checks; `npm test` runs `test/example.test.ts`. Both
legs also run in CI for every bundled example, independently, via
`scripts/gate-examples.mjs`.

## Layout

```
pome.json                       committed manifest: agent.slug + framework + tasks dir
agents/support-triage-v1.yaml   managed-agent baseline — naive, pattern 1
agents/support-triage-v2.yaml   managed-agent fix; one line different
tasks/duplicate-issue.md        the task (inline ## Seed State, ## Discrimination)
src/index.ts                    the graded examinee — both arms, behind one env switch
test/example.test.ts            the silent-failure guards (see its header for what is
                                deliberately left to the other gates)
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
