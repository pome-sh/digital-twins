# Twin Runtime Contract

This contract defines how every Pome digital twin boots and responds.
It also defines the environment interface and recorder tape.

The `pome` CLI, the hosted control plane, and local twins use this contract.
No consumer has special behavior.
A consumer must not depend on behavior that this document does not define.

## Change Procedure

Treat every change to this contract as a breaking change.

1. Update this document.
2. Update the black-box tests in [`contract/`](./contract/).
3. Include both updates in the same pull request.

The tests start the built twins and check this contract.
A mismatch must fail the build.

Pome maintainers must also prepare a `pome-cloud` pull request.
That pull request must pin and verify the new signed twin artifact.
This document is the rule of record for the runtime contract.

Outside contributors do not change the private `pome-cloud` repository.
Pome maintainers change that pin.

## Contract Version

**Version 1.6.0**

The black-box suite in [`contract/`](./contract/) verifies this version.

## Boot Contract

### Entry Point

Start each packaged twin with this command:

```bash
node dist/src/server.js
```

Set the working directory to the twin package root: `packages/twin-<name>`.

After process start, `GET /healthz` must return status `200` within three seconds.

### Boot Secret

Use these rules in order:

1. Use a non-empty `TWIN_AUTH_SECRET` from the environment.
2. Treat an empty `TWIN_AUTH_SECRET` as unset.
3. On a non-loopback host, read the persisted secret when it exists.
4. If the file is absent or blank, generate a 32-byte hexadecimal secret.
5. Write the generated secret to `.pome-data/<twin>/secret`, relative to the working directory.
6. If `POME_TWIN_DATA_DIR` is set, write the secret to `<dir>/secret` instead.
7. Print a newly generated secret to standard output one time.
8. Reuse the persisted secret on later starts. Do not print its value again.

An environment secret always has priority over a persisted secret.
Pome hosted infrastructure injects a different secret for each tenant.
The twin must not generate a secret when the environment supplies one.

The twin must refuse to start if it cannot read or generate the required secret.
The process must return a nonzero exit code.
The error must name `TWIN_AUTH_SECRET`.

Loopback hosts keep the development fallback when `NODE_ENV` is not `production`.
A production process on a loopback host must supply `TWIN_AUTH_SECRET`.

### Runtime Dependencies

The runtime must include these components:

- Hoisted `node_modules`
- `packages/wire` with its built `dist/`
- `packages/sdk` with its built `dist/`

The twins are engine plugins.
The runtime image includes both packages so that hoisted workspace links resolve.

Build the dependencies with these commands:

```bash
npm run build -w @pome-sh/wire
npm run build -w @pome-sh/sdk
```

`@pome-sh/wire` resolves through `exports` to `./dist/index.js`.
A plain Node.js start must load compiled JavaScript.

## Environment Interface

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | Listen port. This value takes precedence over the provider-specific port variable. | Twin-specific port |
| `GITHUB_CLONE_PORT` | GitHub listen port | `3333` |
| `SLACK_CLONE_PORT` | Slack listen port | `3333` |
| `STRIPE_CLONE_PORT` | Stripe listen port | `3333` |
| `GMAIL_TWIN_PORT` | Gmail listen port | `3336` |
| `LINEAR_TWIN_PORT` | Linear listen port | `3337` |
| `GITHUB_CLONE_HOST` / `SLACK_CLONE_HOST` / `STRIPE_CLONE_HOST` / `GMAIL_TWIN_HOST` / `LINEAR_TWIN_HOST` | Bind host | `127.0.0.1` |
| `GITHUB_CLONE_DB` / `SLACK_CLONE_DB` / `STRIPE_CLONE_DB` / `GMAIL_TWIN_DB` / `LINEAR_TWIN_DB` | SQLite path or `:memory:` | Twin-specific data path |
| `GITHUB_CLONE_NO_SEED=1` | Do not apply a GitHub seed at boot | Apply the seed |
| `SLACK_CLONE_NO_SEED=1` | Do not apply a Slack seed at boot | Apply the seed |
| `STRIPE_CLONE_NO_SEED=1` | Do not apply a Stripe seed at boot | Apply the seed |
| `GMAIL_TWIN_NO_SEED=1` | Do not apply a Gmail seed at boot | Apply the seed |
| `LINEAR_TWIN_NO_SEED=1` | Do not apply a Linear seed at boot | Apply the seed |
| `POME_SEED_JSON` | Apply the supplied seed at boot | Apply the default seed |
| `POME_RECORDER_EVENTS_PATH` | Write recorder events as NDJSON to this file | Store recorder events in memory |
| `TWIN_AUTH_SECRET` | HS256 secret for session JWTs and provider-shaped tokens. A supplied value always wins. | Development fallback on loopback unless `NODE_ENV=production`. Generated and persisted on non-loopback hosts. |
| `POME_TWIN_DATA_DIR` | Directory for the persisted boot secret at `<dir>/secret` | `.pome-data/<twin>` relative to the working directory |
| `TWIN_ADMIN_TOKEN` | Use `X-Admin-Token` authentication for `/admin/*`. Compare the value with a timing-safe operation. | Check the loopback socket only |
| `POME_RUN_ID` | Run ID on recorder events | `"spawn"` |
| `POME_TWIN_VERSION` / `POME_TWIN_GIT_SHA` / `POME_TWIN_BUILD_TIME` | Values in the `/healthz` `runtime` object | `0.1.0` / `dev` / `dev` |
| `SLACK_DETERMINISTIC_TS` | Use deterministic Slack message timestamps | Not set |
| `NODE_ENV=production` | Require strict secret handling. Reject unknown peer addresses at the admin gate. | Not set |

A provider-specific no-seed variable takes precedence over `POME_SEED_JSON` and skips all boot seeding.

## Shared Control Plane

These requirements apply to all twins.

### Health

`GET /healthz` is a root route and requires no authentication.
It returns status `200` and this object:

```text
{ok: true, twin, implementation, tools, runtime: {package, version, git_sha, build_time}}
```

`tools` must be greater than `0`.
`healthz.tools` must equal the number of tools in the MCP tool list.

### Administration

`POST /admin/reset` and `POST /admin/seed` do not require a bearer token.

The admin gate has two modes:

- If `TWIN_ADMIN_TOKEN` is set, require header `X-Admin-Token`.
- Return status `403` when this header is missing or incorrect.
- Otherwise, allow requests only when the socket peer is loopback.
- Do not trust proxy headers or client headers for the peer check.
- With `NODE_ENV=production`, reject an unknown peer address.

The implementation is in `packages/sdk/src/admin-gate.ts`.

### Session Authentication

Session routes use the mount `/s/:sid/*`.
They require a bearer JWT signed with HS256 and `TWIN_AUTH_SECRET`.

The claims have this shape: `{sid, team_id, exp, …}`.
The `sid` claim must equal the `:sid` path value.

Each applicable twin also accepts its provider-shaped tokens:

- `ghp_pome_*` and `github_pat_pome_*`
- `xox[bp]-pome-*`
- `sk_test_pome_*`

### Pome Routes

- `GET /s/:sid/_pome/health` returns status `200` and `{ok: true, twin, …}`.
- `GET /s/:sid/_pome/state` returns status `200` and a JSON object.
- `GET /s/:sid/_pome/events` returns status `200` and a JSON array.

The state response is redacted.
Hosted `[code]` scoring reads this response.

The events response is the recorder tape.
Each row must match the `@pome-sh/wire` `recorderEventSchema`.

The `request_headers` and `tool` fields are additive.
A reader must interpret ABSENT as "this recording predates the field."
A reader must not interpret ABSENT as a field value.

`request_headers` contains the received request headers.
Its keys are lowercase.
The twin redacts `authorization`, `cookie`, and `x-api-key` as `[REDACTED]`.

`tool` contains the twin ACTION for the call.
MCP and REST calls for the same action must use the same value.
`null` means that the serving surface declares no action.
It does not mean that no action occurred.

### MCP Routes

- `GET /s/:sid/mcp/tools` returns `{tools: […]}`.
- `POST /s/:sid/mcp` implements stateless streamable-HTTP JSON-RPC.
- `GET /s/:sid/mcp` and `DELETE /s/:sid/mcp` return status `405`.
- `POST /s/:sid/mcp/tools/:name` is a legacy route.
- `POST /s/:sid/mcp/call` is a legacy route.

`POST /s/:sid/mcp/call` accepts exactly `{tool, arguments}`.
It does not accept alias keys.

### Reserved And Unknown Routes

The prefixes `/_pome/*` and `/mcp/*` are reserved under the session mount.
They belong to the platform under rule `OQ-B6`.
Domain routes must not shadow them.

Unless a per-twin section defines an exception, an unknown session route must meet these requirements:

- Return status `501`.
- Use the loud-unsupported envelope.
- Advertise `fidelity: "unsupported"` and the supported surfaces.

## Frozen Per-Twin Differences

These differences are part of the contract.
Change a value only as a deliberate contract change.

| Surface | github | slack | stripe |
| --- | --- | --- | --- |
| `/healthz` `fidelity` field | `"semantic"` | absent | `"semantic"` |
| `/healthz` extras | `access_control` | None | `tthw_seconds` |
| `GET /s/:sid/healthz` | 200 `{ok, sid}` | 200 `{ok, sid}` | **501** because the route is absent |
| `/admin/seed` with garbage body | **422** validation error | **500** `internal_error`. The response names the key. Every throw uses this admin status. | **400** `parameter_invalid`. The message names the key. |
| No bearer | 401 `{message:"Requires authentication", documentation_url, status}` | 401 `{ok:false, error:"not_authed"}` | 401 `{error:{code:"unauthorized", message:"You did not provide an API key. …"}}` |
| Invalid bearer | 401 `{message:"Bad credentials", documentation_url, status}` | 401 `{ok:false, error:"invalid_auth"}` | 401 `{error:{code:"unauthorized"}}` |
| Expired JWT | 401 `"Bad credentials"` | 401 `error:"token_expired"` | 401 `unauthorized` |
| SID mismatch | 401 `{message:"Forbidden", documentation_url, status}` | 401 `invalid_auth` | **403** `{error:{code:"forbidden"}}` |
| Admin-gate 403 body | `{message:"Forbidden", documentation_url, status:"403"}` | `{ok:false, error:"restricted_action"}` | `{error:{code:"forbidden"}}` |
| Raw bearer without the `Bearer ` prefix | 401 rejected | 401 rejected | **200** accepted |
| Unknown tool through `/mcp/call` | 422 validation | 404 `unknown_tool` | 400 `tool_unknown` |
| Unknown root route | 404 | 404 | **401** because the `/v1` authentication wall responds first |
| Root `/v1/*` SDK-compat mount without path SID | None | None | Present. A bearer token is sufficient. |
| Extra session routes | `/_pome/access-control` | None | None |

### Authentication Envelopes

The vendors do not share one envelope.

- GitHub sends `documentation_url` and a string `status`.
- GitHub always uses `https://docs.github.com/rest` because authentication occurs before dispatch.
- Slack sends `ok:false` and does not send `documentation_url` or `status`.
- Stripe sends `{error:{message,type}}` and does not send `documentation_url` or `status`.

GitHub uses `Requires authentication` when the header is absent.
It uses `Bad credentials` when the token is invalid.

Stripe uses the "You did not provide an API key…" text when the header is absent.
It uses `Invalid API Key provided.` when the token is invalid.

The shared `@pome-sh/sdk` 401 and 403 defaults must not add GitHub's `documentation_url` to other twins.
The Gmail and Linear authentication contracts are in their `FIDELITY.md` files and below.

## Frozen Body And Tape Behavior

The contract suite checks every row.

| Surface | github | slack | stripe |
| --- | --- | --- | --- |
| `/admin/seed` form-encoded body | 400 `Problems parsing JSON` | **500** `internal_error`. The form value fails the seed schema. | 200 accepted |
| `/admin/seed` malformed JSON | 400 `Problems parsing JSON` | 200 `{ok:true}`. Tolerant parsing produces `{}`. | 200 accepted. Defaults apply. |
| `GET /s/:sid/_pome/health` exact keys | `ok, twin, implementation, fidelity, runtime` | `ok, twin` | `ok, twin, implementation, fidelity, runtime, tthw_seconds, recorder` |
| `/_pome/state` fetches on the recorder tape | Never | Never | Never |
| `/admin/seed` on the recorder tape | Recorded with `state_delta: null` | Recorded with `state_delta: null` | Not recorded |
| `GET /x402/protected-resource` on the recorder tape | Not applicable | Not applicable | Record both the 402 challenge and paid retry. Set `state_mutation: false` on each. |

The middleware settlement calls remain separate rows.
Each settlement row keeps its own delta.

## Gmail 1.2.0 Pins

### Boot, Identity, And Authentication

- The packaged entry is `packages/twin-gmail/dist/src/server.js`.
- `GET /healthz` must return within three seconds.
- The response must include `twin: "gmail"`, `implementation: "gmail_twin"`, `fidelity: "semantic"`, and `tools: 13`.

- The normalized `gmail_email` JWT claim is the session identity.
- A missing local claim defaults to `pome-agent@pome-twin.test`.
- Hosted issuers must create the claim.
- `POME_GMAIL_TOKEN` is an alias of `POME_AUTH_TOKEN`.
- There is no `provider_credentials.gmail` contract.
- Authentication failures use Gmail's `error.status: "UNAUTHENTICATED"` envelope.
- SID mismatches use the same envelope.
- Raw JWTs without a bearer prefix are rejected.

### Administration, Routes, And Gaps

- `POST /admin/seed` must strictly validate the Gmail seed.
- A successful seed must record one aggregate `{before,after}` state delta.
- Invalid, form-encoded, and malformed JSON bodies must use `INVALID_ARGUMENT`.
- `GET /s/:sid/_pome/health` has exactly `fidelity, ok, twin, version`.
- `GET /s/:sid/healthz` is enabled.
- MCP advertises exactly the captured thirteen launch tools.
- An unknown tool on legacy `/mcp/call` returns 404 `NOT_FOUND`.
- An unknown session route returns 501 `UNIMPLEMENTED` without fidelity or supported-surface fields.
- An unknown root route returns 404.

The following gaps must return a loud 501 response without a side effect:

- `users.watch`
- `users.stop`
- Resumable uploads
- Forwarding delivery
- Calendar processing
- Deleted writes

### Named Faults

Gmail seeds accept an optional `faults` array of named fault primitives.
The default is `[]`.

The `rate-limited` primitive limits a target operation by call count.
The default target is `messages.send`.

1. The first `succeedFirst` matching calls succeed.
2. The next `throttleFor` matching calls return **429 `RESOURCE_EXHAUSTED`**.
3. Later matching calls succeed again.

The response body includes a retry hint.
The response does not include a `Retry-After` header.

The counter belongs to one twin instance.
`POST /admin/reset` clears the counter.

The default seed has no faults.
This additive feature does not change default behavior.

## Linear 1.3.0 Pins

### Boot, Identity, And Authentication

- The packaged entry is `packages/twin-linear/dist/src/server.js`.
- `GET /healthz` must return within three seconds.
- The response must include `twin: "linear"`, `implementation: "linear_twin"`, `fidelity: "semantic"`, and `tools: 22`.

- The normalized `linear_email` JWT claim is the session identity.
- A missing local claim defaults to `admin@pome-twin.test`.
- Hosted issuers must create the claim.
- `POME_LINEAR_TOKEN` is an alias of `POME_AUTH_TOKEN`.
- There is no `provider_credentials.linear` contract.

Resolve credentials in this order:

1. Resolve seeded personal or OAuth tokens with the database-backed `resolveCredential`.
2. Resolve `lin_pome_` provider tokens.
3. Resolve the Pome session JWT.

The default seed includes `lin_test_admin`.

`mountSessionAtRoot: true` exposes GraphQL and MCP at `/`.
It also exposes them at `/s/:sid/*`.

Raw JWTs without a bearer prefix are accepted because `allowRawBearer: true`.

Authentication failures use Linear's GraphQL-shaped envelope.
SID mismatches use the same envelope.
The code is `errors[].extensions.code: "AUTHENTICATION_ERROR"`.

### Administration, Routes, And Gaps

- `POST /admin/seed` must strictly validate the Linear seed.
- A successful seed must record one aggregate `{before,after}` state delta.
- Invalid, form-encoded, and malformed JSON bodies must use `BAD_USER_INPUT`.
- `GET /s/:sid/_pome/health` has exactly `fidelity, ok, twin, version`.
- `GET /s/:sid/healthz` is enabled.
- MCP advertises exactly the captured twenty-two launch tools.
- An unknown tool on legacy `/mcp/call` returns 404 `NOT_FOUND`.
- An unknown session route returns 501 with `fidelity: "unsupported"`.
- An unknown root route returns 401 because the root session authentication wall responds first.

The `list_documents`, `get_document`, and `save_document` MCP tools have semantic fidelity.
Other Linear GraphQL operations remain unsupported.

## Verification

Run the packaged twin contract suite from the repository root:

```bash
npm run test:contract
```

The command builds the required workspaces and runs the contract tests. It excludes the CLI entry test. Run that test after you build the CLI:

```bash
node --test contract/cli-start.test.mjs
```

Test an external built artifact directly with an absolute package path:

```bash
CONTRACT_TWIN_ONLY=github \
CONTRACT_TWIN_PKG_ROOT=/absolute/path/to/twin-package \
node --test contract/contract.test.mjs
```

Use the applicable twin name for `CONTRACT_TWIN_ONLY`.
For Gmail, also include `contract/gmail-fault.test.mjs` in the `node --test` command.
