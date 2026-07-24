# `@pome-sh/twin-gmail`

Deterministic Gmail-shaped twin for agent testing (Pome).

**Status: OSS release candidate.** This package includes the deterministic
SQLite mailbox model, strict seed/reset APIs, canonical MIME storage, identity,
delivery, drafts, labels/history/search, bounded semantic state export,
recording projection, the frozen Gmail REST/upload surface, and the captured
thirteen-tool first-party MCP contract (Gate 1).

## Auth identity (frozen)

| Item | Value |
| --- | --- |
| Claim | `gmail_email` on the Pome session JWT |
| Default local mailbox | `pome-agent@pome-twin.test` |
| Agent token env | `POME_GMAIL_TOKEN` (alias of `POME_AUTH_TOKEN`) |
| Bearer | Pome session JWT — **not** a Google OAuth access token |

Pome owns authentication. This twin does **not** implement Google consent
screens, OAuth codes, refresh tokens, JWKS, or scope issuance.

Mailbox resolution accepts only `me` or the exact `gmail_email` value.
Unknown/cross-mailbox access returns the captured Gmail not-found shape without
revealing mailbox existence.

## Gate 0 artifacts

| Path | Role |
| --- | --- |
| [`fixtures/rest-surface.json`](fixtures/rest-surface.json) | Frozen launch REST method/parameter/media matrix from Gmail v1 discovery |
| [`fixtures/mcp-tools-list.*.json`](fixtures/) | Official Gmail MCP `tools/list` raw + canonical (13-tool Gate-1 launch set) |
| [`fidelity.inventory.json`](fidelity.inventory.json) | Heat × fidelity × evidence for every launch REST/MCP row |
| [`FIDELITY.md`](FIDELITY.md) | Human-readable heat × fidelity tables (linted against inventory) |
| [`REFERENCE-DIVERGENCES.md`](REFERENCE-DIVERGENCES.md) | Emulate rejected; never an oracle |
| [`LIMITS.md`](LIMITS.md) | Limit placeholders (discovery maxima + TBD local caps) |

See [`fixtures/README.md`](fixtures/README.md) for capture provenance and SHA-256.

## Launch MCP tools (exactly 13)

`create_draft`, `list_drafts`, `get_thread`, `get_message`, `search_threads`,
`label_thread`, `unlabel_thread`, `apply_sensitive_thread_label`, `list_labels`,
`label_message`, `unlabel_message`, `apply_sensitive_message_label`,
`create_label`.

Order and schemas are frozen from the live Developer Preview listing capture.
Gate 1 promotes `get_message` and the two `apply_sensitive_*` tools that were
previously named cold preview drift under the Gate 0 ten-tool freeze.

## Named 501 gaps (not fake success)

- `users.watch` / `users.stop` — no Pub/Sub; loud 501
- Resumable upload initiation/chunks — loud 501
- Filter `action.forward` — loud 501 (no forwarding delivery)
- `processForCalendar=true`, `deleted=true` on insert/import — loud 501

## Non-goals

- External SMTP / network mail delivery (`messages.send` is a mailbox-state transition)
- Pub/Sub push notifications
- Google OAuth/OIDC
- Calendar, Drive, Contacts, client UI, CSE, delegates, S/MIME, admin controls
- HTTP batch API
- Resumable upload
- Expanding MCP beyond the frozen Gate-1 13-tool launch set without a new ruling

## Limits

See [`LIMITS.md`](LIMITS.md). Defaults/maxima from discovery are frozen in
`rest-surface.json`. Page tokens are HMAC-bound to mailbox/query/snapshot; set
`POME_GMAIL_PAGE_TOKEN_SECRET` or rely on `TWIN_AUTH_SECRET` (see LIMITS.md).

## Stateful parity with other first-party twins

Gmail follows the same SDK chassis as GitHub / Slack / Stripe:

| Capability | Gmail | Notes vs peers |
| --- | --- | --- |
| `defineTwin` + SQLite domain | yes | Same `@pome-sh/sdk` boot path |
| `/_pome/state` | yes | Bounded digests; history prefers newest 2000 when capped |
| `/_pome/events` + durable recorder | yes | `recordingProjection` redacts MIME/bodies |
| `/admin/reset` + `/admin/seed` | yes | Reports `state_delta` like GitHub (Stripe freezes admin unrecorded) |
| MCP `reportDelta` / no-op `state_mutation=false` | yes | Aligned with REST `rest-routes-kit` |
| Session identity claim | `gmail_email` | Peers use provider-shaped claims |

Intentional differences: no Google OAuth (Pome JWT only); watch/stop 501; Stripe-style idempotency/failure-injection middleware is Stripe-only.

## Runtime contract (for snapshot consumers)

`pome-cloud` builds a Vercel Sandbox snapshot from this package's signed source
artifact. The following constraints must hold for that build to succeed and for
the resulting snapshot to boot. Changing any of these is a breaking change for
hosted; land the producer change here first, then open the cloud consumer PR
that pins and verifies the new signed digest.

### Build

- Package is `npm install`-able from `package.json` alone (no `workspace:*`
  protocols, no package-manager-specific deps; no committed lockfile is required, the snapshot
  build regenerates one on each rebuild)
- `npm run build` exits 0 and emits `dist/src/server.js`
- Built output is loadable under Node 24 — the snapshot runs `runtime: "node24"`.
  SQLite is the built-in `node:sqlite` (via the sdk's `openTwinDatabase()`) —
  no native modules, no compiler toolchain.

### Runtime

- Server entry: `node dist/src/server.js` (cwd = package root)
- Listens on `:3336` by default (`GMAIL_TWIN_PORT`, then the native default)
- **Hosted normalizes the port to `PORT=3333`.** The server honors the `PORT`
  env var first (`PORT` → `GMAIL_TWIN_PORT` → `3336`); the pome-cloud
  control-plane sets `PORT=3333` at spawn for every twin, so the native `3336`
  default is only used for standalone local runs.
- Honors `GMAIL_TWIN_HOST=0.0.0.0` env (default `127.0.0.1` is unreachable via
  Vercel Sandbox port forwarding)
- `GET /healthz` returns 200 within ~3s of process start (the snapshot build
  sleeps 3s after `node dist/src/server.js` before probing)
- Seed via `POME_SEED_JSON` (strict Gmail seed schema)
- Bearer auth at `Authorization: Bearer <jwt>` — Pome session JWT, not a Google
  OAuth access token

### Cloud consumer coordination

- Bumping any of the above = publish a signed twin digest and open the matching
  `pome-cloud` consumer PR.

## Development

```bash
npm test -w @pome-sh/twin-gmail
npm run typecheck -w @pome-sh/twin-gmail
```

Fixture smoke tests assert launch tool count/order and that watch/stop are
marked `named_gap_501`; domain tests cover seed/identity, MIME round-trip,
draft replacement, message labels and computed thread labels, history, search,
local delivery/Bcc privacy, state export, and recorder payload projection.

## CLI

```bash
npx @pome-sh/cli twin start gmail
# prints POME_GMAIL_REST_URL, POME_GMAIL_MCP_URL, POME_AUTH_TOKEN,
# and the identical POME_GMAIL_TOKEN alias
```

Use `pome tasks gmail --copy` for the inbox-triage and captured first-party
MCP parity tasks. Hosted rollout is gated separately; see
[`HOSTED.md`](HOSTED.md).
