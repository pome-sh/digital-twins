# @pome-sh/twin-stripe — CHANGELOG

All notable changes to the Stripe twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).


## 0.4.0 — 2026-07-30

Stripe declares its assertable check vocabulary (F-1127, milestone A3).

- New `./checks` subpath: `STRIPE_CHECKS`, eleven declarations, plus the
  `StripeCheckState` model they read (`check-state.ts`). pome-cloud deletes its
  hand-maintained mirror of that shape in the same milestone — the twin's model
  is now the only one.
- Four declarations replace hand-written regexes the cloud held
  (`payment-intent-amount`, `payment-intent-status`, `no-refund-on-charge`,
  `x402-retry-includes-payment`); seven are new, and each exists because a
  shipped criterion asked for it and bound nothing. Stripe's unbound `[code]`
  criteria go 8 → 0.
- Three of the new ones read the TAPE, because the final state cannot answer
  them: a rejected request mutates nothing, and a 402 challenge mutates nothing.
- `fidelity-contract.test.ts` gains a state-shape parity arm. Unlike Slack's,
  Stripe's export does not spread SQLite rows — every collection goes through
  `serializers.ts` — so the join fields lose their `_id` suffix
  (`refunds.charge_id` → `refund.charge`). The arm pins that renaming against a
  real `exportState()`, along with two documented deviations a fixture must
  model: `charge.refunded` stays false on a partial refund, and a balance
  transaction's `source` points at the PaymentIntent rather than the charge.

Minor: new published exports. No change to the served REST/MCP surface, to
`/_pome/state`, or to any seed schema.

## 0.3.1 — 2026-07-30

Dependency-only patch: repin `@pome-sh/sdk` to 0.10.0 (F-1126). No surface change.

The repin is not cosmetic. npm only symlinks a workspace sibling when the
declared pin matches its version; a stale pin makes npm install a nested
PUBLISHED copy instead, so the package is built and tested against the registry
rather than this tree. `scripts/check-workspace-pins-match-workspace.mjs` now
gates it.

## 0.3.0 — 2026-07-29

The x402 flow reaches the recorder tape (F-1125). Minor: it requires
`@pome-sh/sdk` >= 0.9.0, and the tape gains rows where there were none.

### Fixed

- **Neither x402 leg was recorded at all.** `registerX402Routes` mounted the
  protected resource as a bare Hono handler, and the payment middleware answers
  every challenge leg itself and returns before `next()` — so nothing reached the
  recorder. An unpaid attempt left no trace anywhere: `state_final.json` is
  identical whether the agent paid, failed to pay, or never tried. Both legs are
  on the tape now, with their request headers, which is what makes task 13's
  `The retry includes X-PAYMENT and returns 200` answerable.

### Added

- `request_headers` on the two events this twin builds by hand — `respond()` and
  the idempotency dedupe replay. The replay's `Idempotency-Key` is now readable
  on the one row that is about it.


## 0.2.5 — 2026-07-21

Dependency-only patch: repin `@pome-sh/sdk` to 0.5.1 and
`@pome-sh/shared-types` to 0.12.0 (F-818). No twin surface change.

## 0.2.4 — 2026-07-20

Dependency-only release: repins the shared first-party contract to
`@pome-sh/shared-types@0.11.0` and the additive Gmail-capable engine to
`@pome-sh/sdk@0.5.0`. Stripe wire behavior is unchanged.

## 0.2.3 — 2026-07-16

Strip trailing slashes from `twinBaseUrl` with an `endsWith`/`slice` loop
instead of `/\/+$/`, so CodeQL no longer flags a polynomial ReDoS on
library-controlled input. No API or behavior change.

## 0.2.2 — 2026-07-10

Dependency-only release for the node:sqlite driver swap (F-703):
`@pome-sh/sdk` pinned to 0.3.1 and the direct `better-sqlite3` dependency
dropped — the twin's install closure now has zero native modules. No twin
behavior changes.

## 0.2.1 — 2026-07-10

Dependency-only release: `@pome-sh/sdk` pinned to 0.3.0 (durable write-through
recorder) so the CLI bundle resolves a single sdk copy. No twin behavior
changes.

## 0.2.0 — 2026-07-09

First npm-published release (F-714).

A deterministic Stripe x402 machine-payments twin for agent testing — REST +
MCP surfaces (payment intents, refunds, balance) over SQLite-backed,
balance-consistent state. Built as a thin `@pome-sh/sdk` plugin (F-684): the
twin declares its domain, tools, and Stripe's frozen wire shapes; the engine
owns HTTP mounting, bearer auth, the recorder, MCP dispatch, and the admin
gate.

### Added

- `twin-stripe` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- Stripe x402 REST + MCP tool surface with balance-consistent mutations and
  fidelity-annotated behavior (see `FIDELITY.md`).
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `STRIPE_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry points `createTwinStripeApp` and `StripeDomain` for
  in-process embedding (used by the `pome` CLI's `--local` harness).

## 0.1.0

Initial internal version (pre-engine, self-contained server). Never published.
