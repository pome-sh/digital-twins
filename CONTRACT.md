# Twin Runtime Contract

Every Pome digital twin honours the behaviour written below: how it boots, what
it reads from the environment, which status codes and response bodies it
answers, and the shape of the recorder tape it writes. Build against this
document and any twin — one of the five first-party ones or one you wrote
yourself — behaves the way you expect.

**Changing any item below is a breaking contract change.** Update this document
and the black-box suite in [`contract/`](./contract/) in the same pull request:
the suite boots the built twins and asserts these lines, so a change that lands
in one without the other turns the build red.

Three consumers read this contract — the `pome` CLI, Pome's hosted control
plane, and anyone self-hosting a twin. None of the three is privileged. A
behaviour absent from this document is a behaviour no consumer may rely on.

If you work at Pome, a contract change also needs the pome-cloud pull request
that pins and verifies the new signed twin artifact (rule of record:
`packages/twin-github/README.md`, runtime-contract section). Outside
contributors have nothing to do there — that repo is private, and moving the
pin is our side of the change, not yours.

## Version history

**Version 1.6.0** — the runtime dependency arrangement is `packages/wire` **with its built `dist/`**, 2026-08-05; recorder tape gains `request_headers` + `tool`, and the stripe x402 legs are recorded at all, 2026-07-29; Gmail named fault seeds added 2026-07-24; Linear contract added 2026-07-21; Gmail contract added 2026-07-20; boot-secret self-generation added 2026-07-10. Verified by the black-box suite in [`contract/`](./contract/).

## Boot

- Entry point: `node dist/src/server.js` with **cwd = the twin package root** (`packages/twin-<name>`).
- `GET /healthz` answers **200 within 3 seconds** of spawn.
- Boot secret: an env-injected `TWIN_AUTH_SECRET` **always wins** — pome-cloud injects per-tenant secrets and the twin never self-generates when the variable is set (empty counts as unset). On a non-loopback bind host with no env secret, the twin **self-generates** a 32-byte hex secret, persists it at the compose-era location `.pome-data/<twin>/secret` (cwd-relative; `POME_TWIN_DATA_DIR` overrides the directory), prints it **once** to stdout, and reuses the persisted secret on subsequent boots. If the secret can be neither read nor generated, the twin still **refuses to boot** (exit code ≠ 0; the error names the variable). Loopback binds keep the dev-fallback path.
- Runtime dependency arrangement: hoisted `node_modules` + `packages/wire` **with its built `dist/`** + `packages/sdk` **with its built `dist/`** (the twins are engine plugins; the runtime image ships both so the hoisted workspace symlinks resolve) — `npm run build -w @pome-sh/wire` and `npm run build -w @pome-sh/sdk`. `@pome-sh/wire` resolves through `exports` to `./dist/index.js`, so a plain-`node` boot loads ordinary compiled JS. The GHCR runtime image ships `node:24`; the Dockerfiles are the reference implementation of this arrangement.

## Environment surface

| Variable | Meaning | Default |
|---|---|---|
| `PORT` / `<TWIN>_CLONE_PORT` | listen port | `3333` |
| `GITHUB_CLONE_HOST` / `SLACK_CLONE_HOST` / `STRIPE_CLONE_HOST` / `GMAIL_TWIN_HOST` / `LINEAR_TWIN_HOST` | bind host | `127.0.0.1` |
| `GITHUB_CLONE_DB` / `SLACK_CLONE_DB` / `STRIPE_CLONE_DB` / `GMAIL_TWIN_DB` / `LINEAR_TWIN_DB` | SQLite path or `:memory:` | twin-specific data path |
| `<TWIN>_CLONE_NO_SEED=1` | skip the default seed at boot | seed applied |
| `POME_SEED_JSON` | cloud-supplied seed applied at boot | default seed |
| `TWIN_AUTH_SECRET` | HS256 secret for session JWTs + provider-shaped tokens; env always wins | dev-only fallback on loopback; self-generated + persisted on non-loopback hosts; **required** in production |
| `POME_TWIN_DATA_DIR` | directory for the twin's persisted boot secret (`<dir>/secret`) | `.pome-data/<twin>` relative to cwd |
| `TWIN_ADMIN_TOKEN` | switches `/admin/*` to `X-Admin-Token` auth (timing-safe compare) | loopback-only socket check |
| `POME_RUN_ID` | recorder run id stamped on events | `"spawn"` |
| `POME_TWIN_VERSION` / `POME_TWIN_GIT_SHA` / `POME_TWIN_BUILD_TIME` | `/healthz` `runtime` block | `0.1.0` / `dev` / `dev` |
| `SLACK_DETERMINISTIC_TS` | deterministic Slack message timestamps | — |
| `GMAIL_TWIN_PORT` / `GMAIL_TWIN_NO_SEED=1` | Gmail port / skip default seed | `3336` / seed applied |
| `LINEAR_TWIN_PORT` / `LINEAR_TWIN_NO_SEED=1` | Linear port / skip default seed | `3337` / seed applied |
| `NODE_ENV=production` | strict secret requirement; admin gate denies unknown peer addresses | — |

## Control plane (all twins)

- `GET /healthz` — root, **no auth**: `{ok: true, twin, implementation, tools, runtime: {package, version, git_sha, build_time}}`, `tools` > 0. Invariant: `healthz.tools` equals the length of the MCP tool list.
- `POST /admin/reset`, `POST /admin/seed` — **no bearer**. Gate: `TWIN_ADMIN_TOKEN` mode (header `X-Admin-Token`, 403 when missing/wrong) or loopback-only **socket** check — proxy/client headers are never trusted (`packages/sdk/src/admin-gate.ts`); with `NODE_ENV=production` an unknown peer address is denied.
- Session mount `/s/:sid/*` — bearer JWT, HS256 over `TWIN_AUTH_SECRET`, claims `{sid, team_id, exp, …}`; the `sid` claim must equal the path `:sid`. Provider-shaped tokens (`ghp_/github_pat_pome_*`, `xox[bp]-pome-*`, `sk_test_pome_*`) are also accepted per twin.
- `GET /s/:sid/_pome/health` → 200 `{ok: true, twin, …}`.
- `GET /s/:sid/_pome/state` → 200 JSON object — the redacted state export that feeds cloud-side `[code]` scoring.
- `GET /s/:sid/_pome/events` → 200 JSON array — the recorder tape fetched at end of run. Row shape is `@pome-sh/wire` `recorderEventSchema`. Two fields are additive and a reader must treat ABSENT as "this recording predates the field", never as a value: `request_headers` (the request headers as received, keys lowercased, already redacted — `authorization` / `cookie` / `x-api-key` arrive as `[REDACTED]`) and `tool` (the twin ACTION the call invoked — stamped identically for an MCP `tools/call` and for a REST route that performs the same action; `null` means the serving surface declares no action, **not** that no action happened).
- MCP: `GET /s/:sid/mcp/tools` → `{tools: […]}`; `POST /s/:sid/mcp` (streamable-HTTP JSON-RPC, stateless — `GET`/`DELETE` answer 405); legacy `POST /s/:sid/mcp/tools/:name` and `POST /s/:sid/mcp/call` — the latter takes exactly one body shape, `{tool, arguments}`, and no alias keys.
- Reserved prefixes: `/_pome/*` and `/mcp/*` under the session mount belong to the platform (OQ-B6); domain routes must not shadow them.
- Unknown **session** routes → **501** loud-unsupported envelope advertising `fidelity: "unsupported"` and the supported surfaces.

## Per-twin frozen differences (as observed 2026-07-07)

Several rows are under active ruling. They are frozen **as-is**: changing them later is a deliberate contract change, never a port side effect.

| Surface | github | slack | stripe |
|---|---|---|---|
| `/healthz` `fidelity` field | `"semantic"` | absent | `"semantic"` |
| `/healthz` extras | `access_control` | — | `tthw_seconds` |
| `GET /s/:sid/healthz` | 200 `{ok, sid}` | 200 `{ok, sid}` | **501** (route absent) |
| `/admin/seed` with garbage body | **422** validation error | **500** `internal_error` (message names the key; the admin envelope is 500 for every throw — same row as form-encoded below) | **400** `parameter_invalid` (message names the key) |
| **no** bearer | 401 `{message:"Requires authentication", documentation_url, status}` | 401 `{ok:false, error:"not_authed"}` | 401 `{error:{code:"unauthorized", message:"You did not provide an API key. …"}}` |
| **invalid** bearer | 401 `{message:"Bad credentials", documentation_url, status}` | 401 `{ok:false, error:"invalid_auth"}` | 401 `{error:{code:"unauthorized"}}` |
| expired JWT | 401 `"Bad credentials"` | 401 `error:"token_expired"` | 401 `unauthorized` |
| sid mismatch | 401 `{message:"Forbidden", documentation_url, status}` | 401 `invalid_auth` | **403** `{error:{code:"forbidden"}}` |
| admin-gate 403 body | `{message:"Forbidden", documentation_url, status:"403"}` | `{ok:false, error:"restricted_action"}` | `{error:{code:"forbidden"}}` |
| raw bearer (no `Bearer ` prefix) | 401 rejected | 401 rejected | **200 accepted** |
| unknown tool via `/mcp/call` | 422 validation | 404 `unknown_tool` | 400 `tool_unknown` |
| unknown **root** route | 404 | 404 | **401** (the `/v1` auth wall answers first) |
| root `/v1/*` SDK-compat mount (no path sid; bearer alone) | — | — | yes |
| extra session routes | `/_pome/access-control` | — | — |

**The four auth rows moved, and only for github and stripe.** Each
vendor's 401 was probed live on 2026-08-13 with a deliberately invalid bearer
and with no `Authorization` header at all, and the answer is that they share no
envelope: github sends `documentation_url` (always the generic
`https://docs.github.com/rest` — authentication fails before dispatch, so there
is no operation to name) plus a `status` STRING; slack answers `ok:false` with
neither; stripe answers `{error:{message,type}}` with neither. So the `no` and
`invalid` bearer rows split (github: `Requires authentication` vs
`Bad credentials`; stripe: the "You did not provide an API key…" text vs
"Invalid API Key provided."), and the shared 401/403 defaults in
`@pome-sh/sdk` stopped carrying github's `documentation_url` key. gmail and
linear are the same story and are covered by their own FIDELITY.md.

### Body-parsing and tape corners (pinned 2026-07-08)

Probed against the pre-engine builds (`3cd86eb`); the contract suite asserts every row.

| Surface | github | slack | stripe |
| --- | --- | --- | --- |
| `/admin/seed` form-encoded body | 400 `Problems parsing JSON` | **500** `internal_error` (admin surface has its own envelope; the form value fails the seed schema) | 200 accepted |
| `/admin/seed` malformed JSON | 400 `Problems parsing JSON` | 200 `{ok:true}` (tolerant parse collapses to `{}`) | 200 accepted (defaults applied) |
| `GET /s/:sid/_pome/health` exact keys | `ok, twin, implementation, fidelity, runtime` | `ok, twin` | `ok, twin, implementation, fidelity, runtime, tthw_seconds, recorder` |
| `/_pome/state` fetches on the recorder tape | never | never | never |
| `/admin/seed` on the recorder tape | recorded, `state_delta: null` | recorded, `state_delta: null` | not recorded |
| `GET /x402/protected-resource` on the recorder tape | — | — | **both legs recorded**: the 402 challenge and the paid retry, `state_mutation: false` on each. Was neither before — the payment middleware answered the challenge itself and the resource was a bare handler, so an unpaid attempt left no trace anywhere. The middleware's own settlement calls stay separate rows with their own deltas. |

### Gmail 1.2.0 pins

- Packaged entry: `packages/twin-gmail/dist/src/server.js`; `GET /healthz`
  must answer within the shared three-second bound with `twin: "gmail"`,
  `implementation: "gmail_twin"`, `fidelity: "semantic"`, and `tools: 13`.
- Session identity is the normalized `gmail_email` JWT claim. Missing claims
  default locally to `pome-agent@pome-twin.test`; hosted issuers must mint the
  claim. `POME_GMAIL_TOKEN` is an alias of `POME_AUTH_TOKEN`. There is no
  `provider_credentials.gmail` contract.
- Auth failures and SID mismatches use Gmail's
  `error.status: "UNAUTHENTICATED"` envelope. Raw prefix-less JWTs are rejected.
- `POST /admin/seed` strictly validates the Gmail seed and records one
  `{before,after}` aggregate state delta. Invalid/form/malformed JSON bodies use
  `INVALID_ARGUMENT`.
- `GET /s/:sid/_pome/health` has exactly
  `fidelity, ok, twin, version`; `GET /s/:sid/healthz` is enabled.
- MCP advertises exactly the captured thirteen launch tools. Unknown-tool calls
  on the legacy `/mcp/call` route return 404 `NOT_FOUND`.
- Unknown session routes return 501 `UNIMPLEMENTED`; unknown root routes return
  404. `users.watch`, `users.stop`, resumable uploads, forwarding delivery,
  Calendar processing, and deleted writes remain loud no-side-effect 501 gaps.
- Gmail seeds accept an optional `faults` array of named fault primitives
  (default `[]`). The `rate-limited` primitive throttles a target operation
  (default `messages.send`) by call count: the first `succeedFirst` matching
  calls succeed, the next `throttleFor` return **429 `RESOURCE_EXHAUSTED`**
  (retry hint in the body; **no `Retry-After` header**), then calls recover. The
  counter is per twin instance and cleared by `POST /admin/reset`. The default
  seed carries no faults, so default behavior is unchanged (additive).

### Linear 1.3.0 pins

- Packaged entry: `packages/twin-linear/dist/src/server.js`; `GET /healthz`
  must answer within the shared three-second bound with `twin: "linear"`,
  `implementation: "linear_twin"`, `fidelity: "semantic"`, and `tools: 22`.
- Session identity is the normalized `linear_email` JWT claim. Missing claims
  default locally to `admin@pome-twin.test`; hosted issuers must mint the
  claim. `POME_LINEAR_TOKEN` is an alias of `POME_AUTH_TOKEN`. There is no
  `provider_credentials.linear` contract.
- Auth order: DB-backed `resolveCredential` for seeded personal/OAuth tokens
  (default seed includes `lin_test_admin`), then `lin_pome_` provider tokens,
  then the Pome session JWT. `mountSessionAtRoot: true` exposes the session
  GraphQL/MCP surface at `/` as well as `/s/:sid/*`. Raw prefix-less JWTs are
  accepted (`allowRawBearer: true`).
- Auth failures and SID mismatches use Linear's GraphQL-shaped
  `errors[].extensions.code: "AUTHENTICATION_ERROR"` envelope.
- `POST /admin/seed` strictly validates the Linear seed and records one
  `{before,after}` aggregate state delta. Invalid/form/malformed JSON bodies use
  `BAD_USER_INPUT`.
- `GET /s/:sid/_pome/health` has exactly
  `fidelity, ok, twin, version`; `GET /s/:sid/healthz` is enabled.
- MCP advertises exactly the captured twenty-two launch tools. Unknown-tool calls
  on the legacy `/mcp/call` route return 404 `NOT_FOUND`.
- Unknown session routes return 501 with `fidelity: "unsupported"`; unknown
  root routes return 401 (root session mount auth wall). Documents MCP tools
  and the full Linear GraphQL tail remain loud unsupported / cold gaps.

## Verifying

```
npm run test:contract
```

builds `@pome-sh/wire` + the sdk + all five first-party twins, then runs `node --test` over every `contract/*.test.mjs` file it discovers — no file list to fall off. The one exception is `contract/cli-start.test.mjs`, which needs a built `cli/` this runner does not build; ci.yml runs it as its own step. The suite is dependency-free (node:test, global fetch, node:crypto) so the same file can be pointed at any built twin artifact — including a cloud-built snapshot.
