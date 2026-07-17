# pome MCP — agent (coach) experience notes

Written 2026-07-16 by an agent (Claude) that drove the pome MCP end-to-end as the
**coach**: connected `mcp.pome.sh`, registered "VK Agent - MCP", saved 6 scenarios,
and ran 6 × 3 = 18 trials of `examples/minimal-viktor` on `alibaba/qwen3.7-plus`.
All 18 scored 100/100. The flow works. These are the friction points from an
agent's point of view — what confused me, and where a small change would remove a
whole class of agent mistakes.

## Status (2026-07-17) — most of this shipped

These notes were acted on in `pome-cloud` (branch `devex/mcp-agent-experience`).
Corrections found while implementing, and what changed:

- **#1 seed format** — the MCP *already* emits an explicit diagnostic on a prose
  seed (`parseScenario` throws "replace the prose with a fenced ```json block").
  So it was never silent; the residual gap was ergonomic. `validate_task` /
  `save_scenario` descriptions now say so.
- **#2 transport** — shipped. Agents carry a `transport: rest|mcp` field
  (register_agent / intake_clone_scope); `run_scenario` foregrounds the matching
  launch block and echoes `examinee_launch.transport`.
- **#3 facade URLs** — shipped. `facade_urls` are now omitted in prod (gated),
  surfacing only in non-prod for debugging.
- **#4 expiry race** — the premise was off: the session TTL is **30 min** (not
  ~240s) and idle tracking already exists server-side. The real gap was
  visibility, so `get_session` now returns `idle_seconds` (from
  `last_request_at`) as the "examinee likely done" cue.
- **#5 finalize re-demands scenario** — shipped. The scenario source is stamped
  on the session at mint; `finalize_run` infers it from `session_id`, and
  `scenario_id`/`scenario_source` are override-only.
- **#6 group_id** — the dashboard aggregation bug was already fixed (keys on
  `(group_id, task)`); `run_scenario` now documents the group cardinality.
- **#7 credential plumbing** — shipped. `examinee_launch.env` is a ready-to-
  export REST block (`POME_GITHUB_REST_URL` / `POME_SLACK_REST_URL` /
  `POME_AUTH_TOKEN`).
- **#8 batch trials** — shipped. `run_trials(scenario_id, n)` provisions N trials
  under one `group_id` and hands each session back for the coach to launch.
- **Nits** — `list_scenarios` now disambiguates empty-vs-unauthorized;
  `validate_task` emits the same `{kind,text,twin?}` criterion shape as the other
  tools; a `hermetic: false` boolean now accompanies `known_network_clamp_bypass`.

## What worked well (keep it)

- **`get_started` first.** A single call that lays out the coach/examinee split,
  the 5-step workflow, and error semantics. This is the single biggest reason the
  run succeeded. More MCPs should ship this.
- **Synchronous `finalize_run`.** Score comes back in the same call, no polling,
  no `check_evaluation` dance. Excellent.
- **Judge narratives cite request IDs.** The model-criterion reasons name the exact
  `req_*` where the agent checked collaborators before merging, or named the phishing
  domain. This made it trivial to trust the grade instead of guessing.
- **`validate_task` / `save_scenario` return the parsed criteria** (kind + twin), so
  I could confirm the grammar was understood before spending a run.

## What confused me / cost me time

### 1. Seed format mismatch is invisible until it bites
The bundled `.md` scenarios carry a **prose** `## Seed State` section plus a sidecar
`NN-name.seed.json`. But the MCP requires the seed as a concrete fenced ` ```json `
block *inside* the scenario source. Nothing in the tool schemas says this; I only
knew from a prior session's memory. A first-time agent will paste the prose `.md`
into `save_scenario` and either get a confusing result or a seed that silently
doesn't materialize.
- **Fix:** make `validate_task`/`save_scenario` emit an explicit diagnostic —
  "`## Seed State` present but no fenced json block found (prose detected)". Better:
  accept a separate `seed_json` param, or auto-read a `<name>.seed.json` sidecar.

### 2. REST-based examinees are second-class in the launch payload
`examinee_launch.instructions` leads hard with "launch on Anthropic Managed Agents
with `mcp_servers`." The `rest_urls` path (what a no-own-MCP REST agent like
minimal-viktor actually needs) is a trailing sentence. I had to already know the
examinee's transport to pick the right half.
- **Fix:** record the examinee transport at registration (`transport: rest | mcp`)
  and have `run_scenario` foreground only the relevant launch block for that agent.

### 3. Known-broken URLs ship in an otherwise-actionable payload
`facade_urls` (`/w/<token>/<twin>/mcp`) is included on every `run_scenario` even
though it 404s in prod. It's labeled "reference only," but putting a dead URL next
to the live ones is a trap: an agent that grabs "the github url" can grab the wrong
one.
- **Fix:** omit `facade_urls` in prod, or gate it behind an explicit debug flag, or
  rename it so it can never be mistaken for the working route.

### 4. The session-expiry vs. finalize race is left to the agent
The clock (`expires_at`, ~240s) starts at **provisioning**, not at launch. So when I
provisioned 3 trials in parallel and then launched them, the first session had
already burned several seconds before its agent even started. There's no
"examinee done" signal — I poll the local process and hope I finalize in time.
- **Fix:** start (or let the coach start) the expiry clock at first twin request;
  and/or return a grace window on finalize; and/or expose a lightweight
  "session idle since last twin call" so the coach knows the agent is done.

### 5. `finalize_run` re-demands scenario identity the session already has
I must re-pass `scenario_id`/`scenario_source` to `finalize_run` even though
`session_id` uniquely determines the scenario. This is redundant and is a real
foot-gun: pass the wrong scenario and you mis-grade a correct run.
- **Fix:** infer the scenario from `session_id`; make the param optional/override-only.

### 6. `group_id` semantics are undocumented — and that caused a real bug
`run_scenario.group_id` is described only as "Trial-group id to aggregate runs
under." It doesn't say whether a group is *one scenario × N trials* or *may span
scenarios*. I reasonably used **one** group for the whole 6-scenario exam. The
dashboard then treated every task's trial view as all 18 runs in the group (each
task showed "18 of 18"; the criteria matrix had T1–T18 with diagonal per-scenario
blocks). See the fix landing in pome-cloud alongside these notes.
- **Fix (product):** aggregation must always key on `(task/scenario_id)` within a
  group, never on `group_id` alone.
- **Fix (docs):** state the intended cardinality of a group in the tool schema, and
  ideally let `run_scenario` derive/scope trial numbering per scenario.

### 7. Verbose, repetition-heavy credential plumbing
Each run returns a fresh `agent_token`, and the same bearer appears 3× in the
payload (`agent_token`, `mcp_servers[0].bearer`, `mcp_servers[1].bearer`). For a
REST launch I hand-threaded 6 env vars. Every repeat is a place to transpose a
token between trials.
- **Fix:** return a ready-to-export `env` block for the REST path
  (`POME_GITHUB_REST_URL=… POME_SLACK_REST_URL=… POME_AUTH_TOKEN=…`) so the coach
  copies one object, not six fields.

### 8. No first-class batch/trials ergonomics
Running 6×3 meant 18 `run_scenario` + 18 `finalize_run` calls issued by hand,
parallelized by me. Launching is legitimately the coach's job, but a
`run_trials(scenario_id, n)` helper (that still hands back each session for the
coach to launch) would cut the orchestration surface dramatically.

## Smaller nits
- `list_scenarios` returned `[]` for a team that clearly had agents; it wasn't
  obvious whether that meant "no catalog" or "not authorized." A hint would help.
- Criterion shape differs across tools (`criteria_kinds` counts in `validate_task`,
  per-criterion `twin` in `save_scenario`, `criterion.type` in `finalize_run`).
  One consistent criterion object everywhere would reduce reparsing.
- The `known_network_clamp_bypass` note (web_search/web_fetch escape the clamp) is
  important but easy to miss inside a long string. Consider a boolean
  `hermetic: false` the coach can assert on.

## One-line summary
The exam *ran* on the first serious attempt, which is the important thing. The
remaining friction is almost entirely **"the payload knows something the agent has
to re-derive or already-know"**: seed format, examinee transport, which URL is live,
which scenario a session belongs to, and how trials group. Push those facts into the
tool responses/schema and a cold agent will get it right without a memory of a prior
run.
