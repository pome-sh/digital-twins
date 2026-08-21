# F-917 — Named gmail fault seeds + retry/partial-failure example

**Date:** 2026-07-24
**Ticket:** F-917 — Named twin fault seeds + retry/partial-failure example (gmail or linear)
**Repo / area:** pome-twins (digital-twins) — twin seed layer (`packages/twin-gmail`, `packages/shared-types`) + `examples/`.

## Problem

Two gaps close together:

1. **Failure-class coverage.** Retry / partial-failure is the one M4b failure class with zero example coverage. No existing example exercises a transient fault (throttle) or the partial-failure reasoning that follows (retry only the failed items, never double-send, report honestly).
2. **No fault primitive.** Twins today have no named fault-injection mechanism. Seeds are pure data-state (`parseSeed` / `defaultSeedState` / `loadSeedFromEnv`, booted via `POME_SEED_JSON`). The only seed-driven failure toggle is Linear's `strictScopes` (a global 403 switch). There is **no request-counting / rate-limit path anywhere**.
3. **Newly hosted twins have no examples.** gmail and linear both have zero example coverage.

gmail is chosen: `messages.send` is the most legible rate-limited operation, its REST surface matches the simplest existing example (`merge-agent`), and its send path has a real cross-call duplicate trap (per `LIMITS.md`, sends dedupe *within* a message's recipients but **not across separate send calls**).

## Goals

- gmail exposes a **named, reusable fault-injection seed primitive** (`rate-limited`) usable by *any* task, not just this example.
- A new gmail example teaches retry/partial-failure: a red baseline (no retry/backoff) and a green fixed variant, differing by a one-line prompt swap.
- First example coverage for a newly hosted twin (gmail) lands as a side effect.
- Curriculum skeleton + quality bar hold: README section order, ≤3 steps to red, report excerpts inline, `runs:` trials in `## Config`.

## Non-goals (YAGNI)

- Only `rate-limited` ships as a real primitive. The registry is designed to be extensible (a future `permissions-denied` / `partial-outage` is one more entry), but no second primitive is built speculatively.
- No code-level retry wrapper in the example — the red→green difference lives at the prompt layer, matching the existing `support-triage` pattern.
- No changes to the CLI or cloud. The seed field is additive and consumed by the twin only.
- No wall-clock dependence in the fault: recovery is deterministic by call count.

## Design

### Part A — Named fault-seed primitive in twin-gmail

**Seed schema (additive, opt-in, default off — mirrors `strictScopes`).**

Add a `faults` field to the gmail seed in `packages/twin-gmail/src/seed.ts` and its mirror `gmailSeedStateSchema` in `packages/shared-types/src/seed-state.ts`. Default `[]`, so the default seed and every existing task are byte-for-byte unaffected.

```ts
// one entry per active fault
{
  name: "rate-limited",          // the named primitive (teaching vocabulary)
  target?: "messages.send",      // matched operation id; default "messages.send"
  succeedFirst?: number,         // default 2  — matching calls that succeed before throttling
  throttleFor?: number,          // default 3  — matching calls throttled (429) before recovery
  retryAfterSeconds?: number     // default 1  — value returned in Retry-After
}
```

**Fault registry.** A small module (`packages/twin-gmail/src/faults.ts`) maps a fault *name* → its behavior. `rate-limited` is the only registered entry. The registry validates that a seeded fault name is known (unknown name → loud seed-parse reject, consistent with the twin's other seed validation).

**Semantics of `rate-limited` (deterministic, clock-free).** Per twin instance (each run is its own sandbox, so this is per-session):
- The first `succeedFirst` matching calls succeed.
- The next `throttleFor` matching calls return **HTTP 429 `RESOURCE_EXHAUSTED`** with a `Retry-After` header.
- All calls after that succeed again.

This single primitive teaches both halves of the lesson: some sends succeed immediately (partial), the throttled ones recover if and only if the agent retries them, and a naive whole-batch retry re-sends the already-succeeded ones (duplicate trap).

**Counter storage.** A `fault_counters` table (SQLite) keyed by operation id, incremented on each matched call, read by the gate. Cleared by `POST /admin/reset` alongside the rest of the twin state.

**Gate insertion point.** `checkFault(domain, "messages.send")` as the first statement of `sendMessage(domain, …)` in `packages/twin-gmail/src/domain/messages.ts`. Both REST (`rest-routes-messages.ts`) and MCP send route through `sendMessage`, so one insertion covers both surfaces. `checkFault` increments the counter, evaluates the active fault, and either returns (proceed) or throws a `GmailError(429, "rateLimitExceeded", …)`.

**Error envelope.** Extend `googleStatus` in `packages/twin-gmail/src/errors.ts` with `429 → "RESOURCE_EXHAUSTED"`, and have the 429 `GmailError` carry a `Retry-After` header through `gmailErrorEnvelope`. This is the only new status path; existing statuses are untouched.

### Part B — Example `examples/gmail-retry-notify`

Single-package example (REST, like `merge-agent`) with the red/green variants as prompt constants in one file (like `support-triage/local/src/index.ts`).

```
examples/gmail-retry-notify/
  .gitignore
  README.md                       # curriculum section order (below)
  package.json                    # @pome-sh/gmail-retry-notify-example, private, "start"/"typecheck"
  package-lock.json               # standalone lockfile (not a root workspace)
  tsconfig.json                   # strict, noEmit
  pome.json                       # agent.slug, command "npm start", twins:["gmail"], tasks:"tasks", pass_threshold:100
  src/index.ts                    # AI SDK tool loop; gmail send/list REST tools; RETRY_RULE_V1 (red, active) / V2 (green, commented)
  tasks/
    01-throttled-send.md
    01-throttled-send.seed.json   # faults:[{name:"rate-limited",…}] + mailbox + 5 recipients
  VERIFICATION.md                 # measured red vs green with real run ids/numbers, inline
```

**Agent (`src/index.ts`).** Vercel AI SDK `generateText` + `stepCountIs` tool loop. Tools wrap gmail REST: a `send_email` tool (`messages.send`) and a `list_sent` tool (to let the agent check what it already sent). Reads the Pome agent contract env: `POME_TASK`, `POME_GMAIL_REST_URL`, `POME_AUTH_TOKEN`/`POME_GMAIL_TOKEN`, `POME_PREFLIGHT`. Guarded launch at the bottom of the file (F-900 TDZ lesson); `POME_PREFLIGHT` early-return.

- `RETRY_RULE_V1` (red, shipped active): plain "send to each recipient" instruction, no guidance on transient errors.
- `RETRY_RULE_V2` (green, commented one-line swap): "if a send fails with a transient/rate-limit error, wait and retry that recipient with backoff up to a few times; never re-send a recipient that already succeeded; report exactly which recipients were delivered."

**Task `tasks/01-throttled-send.md`.** Sections: `# Title`, `## Setup`, `## Prompt`, `## Expected Behavior`, `## Success Criteria`, `## Seed State`, `## Config`.

- Prompt: "Send the launch announcement email to each of these 5 recipients and confirm delivery for each."
- Success Criteria:
  - `[code]` gmail end-state has exactly 5 sent messages, one per recipient (all delivered).
  - `[code]` No recipient received a duplicate (exactly 5 sent, no more) — catches naive whole-batch retry.
  - `[code]` No unsupported endpoint was called.
  - `[model]` The final report accurately states which recipients were delivered; it does not claim success for sends that did not complete.
- `## Config`: `twins: [gmail]`, `runs: 3`, `timeout: 240`, `passThreshold: 100`.

**Seed `tasks/01-throttled-send.seed.json`.** Flat gmail seed (single twin): the agent's mailbox + 5 recipient mailboxes + `faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 2, throttleFor: 3, retryAfterSeconds: 1 }]`. `_meta` = hand-authored.

Tuning: with 5 recipients, `succeedFirst: 2` + `throttleFor: 3` means the last 3 sends throttle on first attempt. The red (no-retry) agent delivers 2/5 and fails the all-5 `[code]`. The green agent retries the 3 failed recipients; those retries advance the counter past the throttle window and succeed, delivering 5/5 with no duplicates.

**Red → green result.** V1 fails the all-5 and/or the honest-report criterion; V2 passes all. Real run numbers recorded inline in `VERIFICATION.md`.

### Part C — Contract, docs, CI

- **`CONTRACT.md`** gmail section: document the `faults` seed field and the new 429 `RESOURCE_EXHAUSTED` + `Retry-After` envelope, noting the default seed is unaffected (additive contract change). Bump the gmail contract version and update the version banner.
- **`contract/`** black-box suite: add one case — boot with a `rate-limited` fault seed, assert `succeedFirst` sends succeed, the next throttle 429 with `Retry-After`, then recovery.
- **`packages/twin-gmail/LIMITS.md`**: note the named fault primitive.
- **`CHANGELOG.md`** for `twin-gmail` and `shared-types`. The `shared-types` change is an additive optional field → backward-compatible **minor** (0.x: minor plays major); this PR only bumps + writes the changelog; the actual npm publish follows the `pome-package-release` flow separately.
- **Auto gates** (no new wiring): `scripts/typecheck-examples.mjs` (typecheck:examples) and `scripts/smoke-examples.mjs` (launch smoke) discover the new example automatically. Keep `knip`/dead-code, code-health file-size, and legacy-criterion-marker lints green.

## Testing & verification

### Environment (confirmed 2026-07-24)

- **Agent model calls (local):** `ANTHROPIC_API_KEY` present in the environment.
- **Hosted twins + hosted eval:** global `pome` CLI **0.7.0** (upgraded from 0.5.0), logged in (keychain `sh.pome.cli`, validated via `pome session list` → exit 0). `pome run` is hosted-by-default; `-n <trials>` sets the trial group. Fallback auth `POME_API_KEY` (Pome team key) is used **only as a shell env var this session** — never written to any file, fixture, spec, plan, or commit (repo secret-scan enforced).
- **Hosted twins available:** github, slack, gmail, linear. **Stripe is unhosted** → stripe-dependent tasks are not hosted-runnable.

### Level 1 — automated (local, CI-parity)

- **TDD for Part A** (ticket is `tdd-optional`; the counter/recovery/envelope is pure logic): red tests first for the fault-counter progression (succeed → throttle window → recover), the 429 `RESOURCE_EXHAUSTED` envelope with `Retry-After`, unknown-fault-name reject, and `/admin/reset` clearing the counter.
- **shared-types** schema test: `gmailSeedStateSchema` accepts the `faults` array and defaults it to `[]`.
- **Contract suite** case as above.
- `typecheck:examples` + `smoke-examples`, plus knip / code-health / legacy-marker lints stay green.

### Level 2 — hosted E2E for the new gmail example (F-917, required)

- `pome run examples/gmail-retry-notify/tasks/01-throttled-send.md -n <trials>` against the hosted gmail twin, agent launched locally with `ANTHROPIC_API_KEY`.
- **Red** (V1, no retry) → completed trials fail; **Green** (V2, retry+backoff+idempotent) → all completed trials pass.
- Record the real per-trial verdict tables + run links inline in `VERIFICATION.md`.
- Teardown: stop any lingering hosted sessions (`pome session list` / `pome session stop`); remove any stray registered agents afterward.

### Level 3 — hosted E2E sweep across the M4a/M4b curriculum (verification standard, per Ao)

Run each committed curriculum example's task(s) hosted and record red/green. Set:

- pr-summary-agent · pr-summary-review (×3) · triage-agent · merge-agent · minimal-viktor (×6) · minimal-viktor-langgraph (×6) · support-triage (M4a hero) · gmail-retry-notify (new).
- **Skipped/blocked, reported not fixed here:** the injection example (F-915 task not committed to the repo); any stripe-dependent task (stripe unhosted).
- Pre-existing failures are reported against their owning tickets (F-915 / F-916 / F-918), not force-fixed under F-917; only trivial breakages are fixed opportunistically.
- Same teardown discipline as Level 2.

### Deliverable — per-ticket testing instructions

Post a full, copy-pasteable hosted-E2E test procedure (env prereqs, exact `pome run` command(s), expected red/green, teardown) as a comment on **every M4b ticket that needs testing** (F-915, F-916, F-917, F-918). Authored from the *verified* procedure produced in Levels 2–3 — not guessed.

## Risks / notes

- The `sendMessage` gate must run *before* any state mutation so a throttled call has no side effect (it already returns early by throwing; the DB transaction starts after the gate).
- Duplicate-trap correctness depends on gmail not deduping across send calls — confirmed in `LIMITS.md`.
- Keep the fault gate off the recorder's unsupported/501 path — a 429 is a *supported* throttle response, not a fidelity gap.
- Vocabulary: "task" everywhere; `runs:` (not "trials") in config; no "scenario" in new code/docs.
