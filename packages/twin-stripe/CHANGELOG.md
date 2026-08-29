# @pome-sh/twin-stripe — CHANGELOG


## Unreleased (minor)

**A seed key no field matches is refused, naming the key** (F-1689). `seedSchema`
is `z.strictObject` at every level, including the payment-intent, charge, refund
and balance-transaction rows. The sharpest reading of what this closes is on a
charge: `amount_refunded` is what the seed writes and `refunded` is DERIVED from
it (`serializers.ts`: `amount_refunded >= amount`), so a seed spelling
`amount_refunfed` produced a charge the wire reported as NOT refunded, with no
error anywhere. `cli/tasks/19-stripe-rerefund-persuasion.seed.json` carried a
stray `refunded: true` on its charge for exactly this reason; it is gone, and
the world it seeds is byte-identical (`applySeed` never read the key).

`parseSeed` drops a top-level `_meta` before validating: Pome's provenance block
is not a seed field.

⚠️ **Frozen wire behaviour moves with it.** `POST /admin/seed` with a garbage body
answered 200 `{ok:true}` and now answers 400 `parameter_invalid` naming the key —
stripe's own zod projection, the same 400 family gmail and linear were already
in. CONTRACT.md's per-twin table and `contract/suite.mjs` move in the same commit.

**`@pome-sh/twin-stripe/seed` is the zod-only leaf it was already documented as**
(F-584). `applySeed` and its four raw row inserts move to `src/apply-seed.ts`;
`seed.ts` keeps the schemas, `parseSeed`, `loadSeedFromEnv` and `defaultSeed` and
imports nothing but `zod`, `@pome-sh/sdk/failure-injection-rules` and types.

The claim was false and load-bearing. `registry.ts`'s header and
`scripts/lint/rules/twin-chunks.mjs`'s own hint both told readers "if all you
need is a seed schema or a default world, import the twin's `/seed` subpath — it
is a zod-only leaf", and for stripe it reached `./domain/schema.js` for
`ensureStripeTables`. So a CLI import put stripe's domain in the graph
`pome --version` loads, the lint refused it, and the CLI hand-copied stripe's
seed shape instead — which then drifted for two releases. That rule now ASSERTS
the leaf claim for all five twins, from each seed module as its own entry.

**`applySeed` keeps its name and moves door, not surface.** It is exported from
the package ROOT (`@pome-sh/twin-stripe`), beside `StripeDomain` and
`openTwinStripeDatabase` — which is where `@pome-sh/sandbox-domains/stripe`
already reaches those two, so that package's published surface is unchanged. Only
`@pome-sh/twin-stripe/seed` loses the symbol.

`SeedState` continues to be exported from `/seed`.


## 0.4.7 — 2026-08-11

`GET /v1/customers/:id/payment_methods` no longer accepts `created` (F-1389).

The route shared the twin's `LIST_QUERY`, which carries `created`.
`GetCustomersCustomerPaymentMethods` declares `allow_redisplay, ending_before,
expand, limit, starting_after, type` and no `created`, and Stripe's measured
disposition is `refuse` — it publishes `parameter_unknown`. So a request Stripe
rejects outright used to succeed here, and an exam scored a call the real API
declined. The route's query is now spelled out rather than spread from
`LIST_QUERY`, so a future edit to that shared shape cannot put `created` back by
inheritance. This twin REFUSES undeclared inputs, so the parameter is now a 400
naming it — which is the point, not a side effect.

## 0.4.6 — 2026-08-06

Its MCP tool table is now derived from `fixtures/mcp-tools-list.raw.json`
rather than declared in TypeScript (F-1325). The fixture's provenance —
substrate, endpoint, protocol version, capture date and the sha of the raw
bytes — is validated at load, and the derivation is 1:1 in both directions, so
a tool the fixture does not declare and a fixture tool nothing implements are
each a throw at module load.

Name-neutral by construction: `tools/list` and the legacy `/mcp/tools` surface
are byte-identical before and after.

**Removed from the package root**: `listTools` and `toolDefinitions`. Nothing
served them — the engine answers both `/mcp/tools` and `tools/list` from
`definition.tools` — so they were a second projection of the same table. The
replacements are `stripeToolFixture`, `stripeToolInputSchema` and
`toolArgumentSchemas`. This package is `private: true` and on no registry, and
neither published tarball re-exposes a twin package root, so no installable
consumer can have been importing them; every in-repo caller moved in the same
change.

## 0.4.4 — 2026-08-04

Dependency-only patch (#302): `hono` `^4.12.31` → `^4.13.0`, `zod` `^4.1.13` → `^4.4.3`, `@hono/node-server` `^2.0.10` → `^2.1.0`.
No source file changed and `npm run test:contract` is green, so the surface is
identical — this exists so the npm artifact stops differing from `main`, which is
the staleness the publish skip-guard cannot see.

## 0.4.3 — 2026-08-04

- Re-pinned to `@pome-sh/sdk@0.11.0` / `@pome-sh/shared-types@0.14.0` for the F-1200 parent-vocabulary
  change: a recorded row now carries `parent_event_id` rather than `parent_id`.
  No change to this twin's own surface — `npm run test:contract` is green.

All notable changes to the Stripe twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).


## 0.4.2 — 2026-08-03

Every state-reading check says where it looked (F-1197).

- 7 declarations now fill `CheckOutcome.evidenceStatePaths` (new in
  `@pome-sh/sdk` 0.10.1) with RFC 6901 pointers into this twin's exported tree.
- `check-state.ts`'s resolvers return the pointer they walked. `Resolved<T>`'s
  found arm gains `path`; its missing arm gains an optional `searched`, naming
  the collection a failed lookup scanned.
- `checks-contract.test.ts` gains the citation gate and an EMPTY
  `HONEST_UNCITED_CHECKS` ledger.

A failed lookup cites too, and that is the half worth knowing about. A charge the account does not hold SKIPS, and `refund_count is 0` against a charge nobody has is exactly the conflation `resolveCharge` exists to prevent.
So the honest citation on that arm is not the row — there is none — but the list:
*this is where I looked, see for yourself that it is not in it.*

Requires `@pome-sh/sdk` 0.10.1: the declarations call `statePath` /
`childStatePath`, which 0.10.0 does not export.

No sentence, template, substrate or check id changed, so `checksDigest` is
identical and no criterion re-binds.

## 0.4.1 — 2026-07-31

`after_handler` failure injection stops eating the `Idempotency-Key` record
(F-1138).

- The mode models "the server processed it, but response delivery to the client
  failed." Real Stripe writes the idempotency record server-side in that
  situation — it is the entire reason the header exists, because a retry then
  replays. The twin persisted the mutation and dropped the key: it modelled the
  half of the failure that hurts and none of the half that protects.
- Mechanism: the injected status is substituted INSIDE the handler, which is
  inside `idempotencyMiddleware`, so the cache saw a 402, declined it under the
  "never cache a 4xx" rule, and stored nothing. The retry was a cache miss and
  committed the mutation a second time. `respond()` now parks the handler's own
  status + body on the context and the idempotency layer decides on that, so it
  caches the real 200 and the retry replays it.
- Middleware order is unchanged, and so is the argument for it: a
  `before_handler` envelope is still produced outside the cache and still never
  stored, so a retry under the same key re-invokes the handler. A genuine 4xx
  from a handler is still not cached either — the layer now asks what the
  HANDLER answered, and a real client error answered 4xx.
- Wire and tape are unchanged: the injected attempt still delivers 402 with the
  configured envelope and is still recorded with `state_mutation: true` plus the
  real `state_delta`.
- This moves `cli/tasks/14-stripe-refund-retry.md`: an agent that sends the same
  `Idempotency-Key` on the retry now ends at one refund row instead of two, so
  the task's second criterion separates it from an agent that retries blind.
  `test/after-handler-idempotency.test.ts` carries the five-archetype
  measurement, promoted from F-1127's grading notes into the test tree.

Patch: bug fix. No change to the served REST/MCP surface, to `/_pome/state`, to
any seed schema, or to the declared check set.

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
