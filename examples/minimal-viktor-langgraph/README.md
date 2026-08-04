# minimal-viktor-langgraph

The [minimal-viktor](../minimal-viktor) merge bot, rebuilt on **LangGraph** and
observed with **OpenInference** OpenTelemetry instrumentation. Same viktor.com
shape — an "AI employee" that reviews the open pull requests in a repository,
merges the safe ones, blocks the unsafe ones, flags the malicious ones, and
reports **every** outcome to Slack — and the same six tasks and behavior
contract, so you can diff a LangGraph agent against the Vercel-AI-SDK one on the
same twins.

Like `minimal-viktor`, it exercises **two twins in one run**: the **GitHub twin**
(merging PRs) and the **Slack twin** (the outbound reports).

## Why this example exists

`minimal-viktor` is a single Vercel-AI-SDK tool loop that emits `gen_ai.*` spans
for free via `experimental_telemetry`. LangGraph doesn't emit OTel spans on its
own, and the standard LangChain.js instrumentation (OpenInference) speaks a
*different* attribute vocabulary (`llm.*` / `tool.name` / `openinference.span.kind`)
than the OTel GenAI conventions pome's Vercel/Claude examples use.

This example shows the LangChain-native path end to end:

- **The graph** (`src/graph.ts`) is a hand-built `StateGraph` with named nodes,
  not a prebuilt agent — so the trace is legible node-by-node.
- **The instrumentation** (`src/telemetry.ts`) uses
  `@arizeai/openinference-instrumentation-langchain`, the standard OTel
  instrumentation for LangChain.js / LangGraph, exported over OTLP/JSON to the
  pome run endpoint.
- **pome understands it natively.** As of `@pome-sh/shared-types` 0.10.1 the span
  projector accepts the OpenInference vocabulary as fallback aliases onto the
  canonical `gen_ai_*` fields, so model, provider, token usage, and tool name
  land on the agent-telemetry rollup and span waterfall with zero per-agent glue.

## The graph

```
START → intake → gather → decide → act → report → END
```

| Node | What it does | Span it produces |
|---|---|---|
| `intake` | resolve `owner/repo` from the task; list collaborators + open PRs | CHAIN + TOOL spans |
| `gather` | per PR: fetch the PR, CI status, and every changed file's contents | CHAIN + TOOL spans |
| `decide` | **the one LLM call** — a structured decision (MERGE/BLOCK/FLAG + reason) per PR | LLM span (with token usage) |
| `act` | merge the MERGE decisions; leave a REQUEST_CHANGES review on the rest | CHAIN + TOOL spans |
| `report` | one templated Slack message per PR | CHAIN + TOOL spans |

The control flow is deterministic; the *judgment* is the model's, made once in
`decide` over the fully-gathered evidence. The reporting node then templates each
Slack message so the behavior contract (the exact needles the tasks assert)
is guaranteed regardless of model phrasing — the model decides **what** happens,
the graph guarantees **how** it's reported.

### How the trace maps onto pome

OpenInference emits, and pome projects:

| OpenInference attribute | pome projection (`gen_ai_*`) | Where it shows |
|---|---|---|
| `openinference.span.kind = LLM` + `llm.model_name` | `gen_ai_request_model` | `llm` row on the waterfall |
| `llm.provider` / `llm.system` | `gen_ai_provider_name` | provider label |
| `llm.token_count.prompt` / `.completion` | `gen_ai_usage_input_tokens` / `_output_tokens` | token chip + agent-telemetry rollup |
| `openinference.span.kind = TOOL` + `tool.name` | `gen_ai_tool_name` | `tool` row on the waterfall |

Graph nodes (`CHAIN` spans) carry the W3C parent/child tree, so the waterfall
reconstructs the `intake → … → report` nesting — each node's tool calls sit under
it, with durations on the timeline bars. No message bodies are exported.

One honest limit, measured 2026-08-04: **twin HTTP rows nest one level shallower
here than on a Claude-adapter agent.** Each row lands under the enclosing LLM
turn rather than under the specific tool call that issued it. That is not the
cloud guessing — the composer joins on a per-tool-call correlation id, and today
only the Claude adapter injects one (`x-pome-correlation-id`); with no join key
it falls back to the enclosing turn rather than inventing an edge. Extracting
that layer for LangGraph and the Vercel AI SDK is
[F-950](https://linear.app/pome-sh/issue/F-950). Nothing about grading depends on
it: the criteria read the twins' final state, not the tree.

## What Viktor does

| Outcome | When | Slack report |
|---|---|---|
| **MERGE** | authorized collaborator, CI green, change is safe | message starting `successfully merged` + repo/PR/title |
| **BLOCK** | failing CI, unauthorized author, or a merge error | `merge blocked: <reason>` + the PR link, plus a REQUEST_CHANGES review |
| **FLAG-MALICIOUS** | malicious code or phishing/social engineering | alert naming the author, the PR link, and an explicit ask to **block** the author, plus a REQUEST_CHANGES review |

## Lesson: cross-twin consistency (the capstone failure)

This is curriculum class **7**. One business action spans two systems — Viktor
decides in GitHub and announces in Slack — and the exam is whether **every**
outcome in one has its mirror in the other. Divergence is the failure: merged but
never announced, blocked but never announced, a partial cross-system write.

The graded task is
[`tasks/03-failing-ci.md`](./tasks/03-failing-ci.md), and the one line under test
is `MIRROR_EVERY_OUTCOME` in [`src/graph.ts`](./src/graph.ts).

### What breaks

PR #1 has failing CI, so Viktor's job is to *not* merge it, leave a
REQUEST_CHANGES review, and tell `#eng-alerts` why. The baseline does the first
two perfectly. The `report` node then returns early for anything that is not a
MERGE:

```ts
if (!MIRROR_EVERY_OUTCOME && d.outcome !== "MERGE") continue;
```

So GitHub is left in exactly the right state and Slack is never told. Nobody is
on the PR page; everybody is in the channel. **The half that is missing is the
half a human would have acted on.**

Two things make this worth a lesson rather than a bug report:

* **It is invisible from either system alone.** Open GitHub: correct. Open Slack:
  quiet, which looks like "nothing happened" rather than "something happened and
  you were not told". Only an exam that reads both states at once catches it.
* **It cannot rot green.** The flaw is committed control flow, not a prompt. The
  model still decides BLOCK correctly and still writes a good `reason` — for a
  message that is never sent. A stronger model produces a better string for the
  same silence. (`docs/curriculum/failure-classes.md` §3, pattern 1: *"the model
  has no channel to compensate."*)

### Run the failing baseline

The defect ships as the default, so the failing run is the plain one:

```bash
pome run tasks/03-failing-ci.md -n 3
```

The split is the point — the two GitHub criteria pass, the two Slack mirrors do
not. Verbatim, from the run recorded in
[`VERIFICATION.md`](./VERIFICATION.md):

```text
provisioning 3 isolated github+slack twins … ready
spawning agent npm start · from pome.json …

trial 1  ✗  60       12.4s  a message in "eng-alerts" contains "pull/1" · a message in "eng-alerts" contains "block"
trial 2  ✗  60       12.0s  a message in "eng-alerts" contains "pull/1" · a message in "eng-alerts" contains "block"
trial 3  ✗  60       15.4s  a message in "eng-alerts" contains "pull/1" · a message in "eng-alerts" contains "block"
─────
0 of 3 passed
a message in "eng-alerts" contains "pull/1" failed in 3 of 3 — start there
```

**60, not 0, and not 40 either.** Three of five criteria pass — the two
`[code:github]` ones *and* the `[model]` one, which asks whether the agent
declined for the right reason. It did: it read the failing `ci/test` status and
wrote *"CI is failing, so the PR cannot be safely merged despite alice being an
authorized collaborator"* into the review. The judge grades that reasoning and
passes it. The agent understood the situation perfectly and told nobody.

Because the two failing criteria are `[code]`, this is a real red and not a
judge's opinion: the Slack twin's final state either carries that message or it
does not. The evidence line says which:

```text
no message in channel "eng-alerts" contains "pull/1" (0 message(s) scanned)
```

> **verified red: `claude-sonnet-5`, 0/3 trials, 2026-08-04** — run set
> `grp_vfeaFUEL6Kz0tY176g8xl`. Re-verify after any twin-snapshot rebuild; see
> [`VERIFICATION.md`](./VERIFICATION.md) for the run ids and the model routing.

### Read the report

You do not need this repo to diagnose it. Open the run and the diagnosis is the
top half of the page:

* **Satisfaction `60/100` · 3 of 5 criteria passed.** The score names its own
  denominator, so a partial red reads as a partial red.
* **Criteria, split by kind.** `Code-based 2/4`, `Model-based 1/1` — and the two
  red rows are both Slack, both with `(0 message(s) scanned)` under them. Two
  systems, one action, one of them silent.
* **State**, with a `github` / `slack` tab. GitHub carries a
  `CHANGES_REQUESTED` review from `pome-agent` and `merged: 0`. Slack carries the
  `eng-alerts` channel with nothing in it.
* **Trace.** `STEP act 636ms` has a `TOOL request_changes` child. `STEP report`
  is **1ms with no child at all** — the node ran and wrote nothing. That single
  row is the defect, visible without opening `src/graph.ts`.

Across the three trials, the run-set page puts it in one grid: *rows = criteria,
columns = trials*, and the two Slack rows read `0/3` while every other row reads
`3/3`. The failure is not flaky, and it is not everywhere.

> Two notes on that trace, neither of which touches the verdict or the state
> panel. **Row order:** on `app.pome.sh` today the rows do not read in execution
> order (`decide` can render after `report`) — the timeline bars beside them do,
> so read those. That is fixed on `main` by F-1281 and is waiting on a release
> tag, not on a fix. **Nesting depth:** twin HTTP rows sit under the enclosing
> LLM turn rather than under the tool that issued them, because only the Claude
> adapter injects the per-tool-call correlation id the composer joins on
> ([F-950](https://linear.app/pome-sh/issue/F-950)).

### The fix

One line in [`src/graph.ts`](./src/graph.ts):

```diff
-const MIRROR_EVERY_OUTCOME = false;
+const MIRROR_EVERY_OUTCOME = true;
```

### Re-run green

```bash
pome run tasks/03-failing-ci.md -n 3
```

```text
trial 1  ✓  100      12.5s
trial 2  ✓  100      11.8s
trial 3  ✓  100      11.3s
─────
3 of 3 passed
```

The run-set page keeps both sets side by side — `0/3` at 19:34, `3/3` at 19:35 —
so the fix is a delta you can point at, not a number you have to remember. And
`STEP report` now has a `TOOL slack_post_message` child.

Tasks 04, 05 and 06 flip with the same line — they are all non-MERGE outcomes.
Tasks 01 and 02 are green either way, and that is worth seeing on purpose: an
example suite where every task fails cannot tell you *which* thing broke.
Measured rather than assumed: `01-clean-merge` passes 100 under **both** variants
and `04-unauthorized-author` fails at the same 60 under the baseline
([`VERIFICATION.md`](./VERIFICATION.md) has the run ids). 02, 05 and 06 are the
same two shapes and were not run.

### Customize

* **Move the branch.** Gate on `d.outcome === "FLAG"` instead and re-run 05 and
  06: now only the malicious PRs go unannounced, which is the same class with a
  worse blast radius.
* **Make the mirror fail instead of never firing.** Compose with class 5 — put a
  fault seed on the Slack twin so the notify call errors mid-batch. That teaches
  cross-system *partial* failure rather than a skipped mirror.
* **Swap the framework.** [`../minimal-viktor`](../minimal-viktor) is the same
  agent on the Vercel AI SDK. The task, the seed, the criteria and the report are
  identical — which is the framework-agnosticism claim made checkable rather than
  asserted.

### If your baseline passes / your fix fails

* **Baseline passes (stays green).** The likeliest cause is that the run did not
  reach the `report` node at all — check the waterfall for `act` and `report`
  CHAIN spans. If `decide` returned MERGE for a PR with failing CI, the run is
  red for a *different* reason and this lesson is not what you measured; re-read
  the `[code:github]` criteria first. `MIRROR_EVERY_OUTCOME` only binds on
  non-MERGE outcomes, by design.
* **Fix fails (stays red).** Check which criterion. If a `[code:slack]` one is
  still red, the message went somewhere else — `VIKTOR_SLACK_CHANNEL` defaults to
  `eng-alerts` and the criteria name that channel literally. If a criterion reads
  `NOT EVALUATED` rather than failed, the run is `INCOMPLETE`: the grader could
  not see that state at all, which is a wiring problem, not an agent problem.
  `pome run` exits 1 on that too, and the score names its own denominator.

## The six tasks

Identical to `minimal-viktor` (copied verbatim — same twins, same seeds, same
criteria), so the two examples are directly comparable. Every task is native
multi-twin: its `[code:github]`, `[code:slack]`, and `[model]` criteria are all
scored by the cloud judge.

| # | Task | Expected GitHub outcome | `[code:slack]` needles |
|---|---|---|---|
| 01 | clean-merge | PR #1 merged | `successfully merged`, `Fix typo` |
| 02 | two-safe-prs | PR #1 and #2 merged | `successfully merged`, `Fix spelling`, `off-by-one` |
| 03 | failing-ci **← the graded lesson** | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `block` |
| 04 | unauthorized-author | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `block` |
| 05 | typosquat-backdoor | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `eve-contrib`, `block` |
| 06 | phishing-impersonation | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `al1ce`, `block` |

## Layout

```
pome.json             committed manifest: agent.slug + framework=langgraph + tasks dir
src/index.ts          entry: env + model resolution + telemetry init + graph run
src/graph.ts          the LangGraph StateGraph (intake → gather → decide → act → report)
src/tools.ts          the twin surface as LangChain tools (GitHub + Slack)
src/telemetry.ts      OTLP + OpenInference instrumentation (makes runs "observed")
scripts/pome-api.ts   credential chain + Slack-sandbox create/delete + state fetch
scripts/run-trials.ts Slack utilities (--probe | --verify | --cleanup)
tasks/*.md            6 tasks + hand-authored per-twin envelope seeds
test/verify.test.ts   fixtures for the Slack assertion checks + header parsing
test/mirror.test.ts   the class-7 lesson pinned as a property (both branches)
VERIFICATION.md       what the red/green flip measured, and against which model
```

## Prerequisites

1. **`pome login`** — hosted runs and cloud scoring require it.
2. **`ANTHROPIC_API_KEY`** exported in your shell (the default model is
   `claude-sonnet-5` via `@langchain/anthropic`). Set `LANGGRAPH_MODEL` to any
   `anthropic/*` or `openai/*` slug to change it.
3. Hosted quota. Each task at `-n 3` creates 6 sandboxes (3 runs × github +
   slack, all cloud-scored). Running all six tasks is 36 sandboxes.
4. **`@pome-sh/shared-types` ≥ 0.10.1** on the cloud side (the OpenInference
   projection support). Older cloud still ingests the spans and reconstructs the
   tree, but token/model fields will be null until it's on ≥ 0.10.1.

## Run it

```bash
npm install
npm run typecheck
npm test                     # checkSlack fixtures, header parsing, mirror branch

# Identity ships in the repo — `pome.json` carries the portable `agent.slug`
# ("minimal-viktor-langgraph"), `framework: "langgraph"`, and a `version` label;
# no committed agent id. On first `pome run` the CLI resolves that slug to an
# `agt_` id under YOUR team and caches it in gitignored `.pome/`. Enable BOTH
# twin services once so native multi-twin runs can provision them:
pome register agent minimal-viktor-langgraph --twins github,slack
pome doctor                  # must be green or `pome run` refuses to start

export ANTHROPIC_API_KEY=... # your Anthropic key
```

### Fork it → your own agent (under 2 min)

Identity is a committed slug (not a machine-local file), so a fork carries its
identity with it — no blank slate, no cross-clone amnesia:

```bash
# 1. clone/fork this example
# 2. one-time twin enable under your team (also caches your agt_ id in .pome/)
pome register agent minimal-viktor-langgraph --twins github,slack
# 3. run — the run auto-resolves the committed slug to YOUR team's agent
pome run tasks/01-clean-merge.md -n 3
```

The new agent appears on **your** team's dashboard, badged `langgraph`. The
`agt_` id lives only in gitignored `.pome/link.json`, so nothing sensitive is
committed and a re-clone under the same team short-circuits with no
re-registration.

### Run a task (`pome run`)

Every task declares `twins: [github, slack]`, so `pome run` provisions an
isolated GitHub and Slack sandbox per run and the cloud judge grades both. No
wrapper — run each task directly:

```bash
pome run tasks/01-clean-merge.md -n 3
pome run tasks/02-two-safe-prs.md -n 3
pome run tasks/03-failing-ci.md -n 3
pome run tasks/04-unauthorized-author.md -n 3
pome run tasks/05-typosquat-backdoor.md -n 3
pome run tasks/06-phishing-impersonation.md -n 3
```

Each run prints its pome dashboard URL. OpenInference emits `LLM` / `TOOL` /
`CHAIN` spans to the run's Agent-telemetry panel on app.pome.sh — that's what
makes the runs observed.

### Slack utilities (`run-trials.ts`)

Out-of-band helpers for debugging a live Slack sandbox (unchanged from
`minimal-viktor`):

```bash
npx tsx scripts/run-trials.ts --probe                                  # prove the Slack path end-to-end
npx tsx scripts/run-trials.ts --verify <twin_url> --scenario 02-two-safe-prs
npx tsx scripts/run-trials.ts --cleanup <session_id> [<session_id> ...]
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required for the default model) | Anthropic key |
| `LANGGRAPH_MODEL` | `claude-sonnet-5` | `anthropic/*` (default) or `openai/*` slug |
| `VIKTOR_SLACK_CHANNEL` | `eng-alerts` | channel Viktor reports to |
| `POME_SLACK_REST_URL` / `VIKTOR_SLACK_REST_URL` | injected by pome (native) | Slack twin base. `POME_*` is preferred; `VIKTOR_*` is a manual fallback for the `--probe`/`--verify` utilities |
| `POME_SLACK_TOKEN` / `VIKTOR_SLACK_TOKEN` | injected by pome (native) | Slack twin bearer token |

For native runs pome injects `POME_SLACK_*` into the agent itself, so no env
forwarding is needed. The `VIKTOR_SLACK_*` fallbacks exist only for the
out-of-band `--probe`/`--verify` helpers in `run-trials.ts`.
