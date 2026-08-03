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
| recognized the existing issue, opened no duplicate | model | the dedup decision |
| concrete repro steps | model | quality of the tracked report |

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
[`local/`](./local/) — the same agent as a Claude Agent SDK process on your
machine. The one line under test is `DENY_ISSUE_LOOKUP` in
[`local/src/index.ts`](./local/src/index.ts).

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

* **It cannot rot green** (§3, pattern 1). The prompt here is the *right* one,
  and a stronger model follows it *more* reliably, not less — it just gets
  refused faster. No model capability can call a tool that was never exposed.
  The previous baseline lived in a prompt line telling the agent not to search;
  that red is model-dependent, and worse, a prompt-driven red is
  indistinguishable from an evaluator that never ran.
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

> **verified red: `<model>`, n/N trials, `<date>`** — pending. The recorded
> numbers in [`VERIFICATION.md`](./VERIFICATION.md) measured the *old*
> pattern-2 baseline, under fail-open scoring, against pre-2026-08-03 twin
> images. They are kept as history and are **not** this baseline's stamp.

### Read the report

The pivotal criterion is the `#support` message linking `issues/1`. Under the
baseline the agent links `issues/2` — the one it just created — so the criterion
fails on a deterministic state read rather than a judge's opinion, and the
state-diff panel shows `issues: 1 → 2`.

The span waterfall shows the rest of the story, and it is the part that makes the
diagnosis fast: a `search_issues` tool span that returns a refusal, followed by
`create_issue`. The agent tried.

### The fix

One line in [`local/src/index.ts`](./local/src/index.ts):

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

* **Baseline passes (stays green).** Check the waterfall for a `search_issues` or
  `list_issues` span that *succeeded* — if one did, the twin exposed a read path
  the denial list does not name, and the fix is to add it (and to say so in
  `ISSUE_LOOKUP_TOOLS`), not to weaken the criteria. `test/tool-policy.test.ts`
  pins the list for exactly this reason.
* **Fix fails (stays red).** If a criterion reads `NOT EVALUATED` rather than
  failed, the run is `INCOMPLETE` — the grader could not see that state at all,
  which is a wiring problem rather than an agent problem. `pome run` exits 1 on
  that too, and the score names its own denominator. If the `[model]` criteria
  are the red ones, raise `-n`: one clean set is a signal, not proof.

### Known gap in the criteria

The criteria above assert that the agent **linked the right issue**. They do not
yet assert that it **opened no second one** — a negative assertion the declared
GitHub vocabulary could not express until `github.no-new-issues`
([F-1198](https://linear.app/pome-sh/issue/F-1198)). Until that check reaches the
cloud's pin, an agent that comments on #1, posts the link *and also* files a
duplicate passes. Said out loud here rather than left for a reader to discover,
because this example is the one that defines the standard.

## Local examinee

[`local/`](./local/) is the same agent as a minimal **Claude Agent SDK process
on your machine** — no managed-agent platform needed. The coach spawns it as a
subprocess after `run_task` (per-twin MCP URLs + bearer arrive via env), it
works the task over MCP, and exits when done. It imports `query` from
`@pome-sh/adapter-claude-sdk` rather than the raw SDK — a drop-in that also
emits gen_ai OTLP spans, so the report carries model, per-turn tokens and
latency. See [`local/README.md`](./local/README.md).

## Layout

```
pome.json                       committed manifest: agent.slug + framework + tasks dir
agents/support-triage-v1.yaml   managed-agent baseline (prompt flaw, pattern 2)
agents/support-triage-v2.yaml   managed-agent fix; one line different
tasks/duplicate-issue.md        the task (inline ## Seed State)
local/                          the graded examinee — the pattern-1 baseline lives here
local/test/tool-policy.test.ts  the lesson pinned as a property (both branches)
VERIFICATION.md                 measured results, and what each measurement was of
```

## Notes

- The bearer token in each `examinee_launch` is **sensitive** — keep it in memory
  only; never write it to disk or into a task.
- The declared `mcp_servers` URLs (`mcp.slack.com`, `api.githubcopilot.com`) are
  the agent's *real* servers; Pome swaps them for per-session twin URLs at run
  time. Do not intake `support-triage-v1` against a real deployment — it files
  duplicates by design.
