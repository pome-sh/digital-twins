# Pome Twin: Slack

> **Internal package.** One of five twin runtimes in this repository (GitHub,
> Stripe x402, Slack, Gmail, Linear). It is not separately installable — it
> ships inside [`@pome-sh/cli`](../../cli/). To run it:
> `npx @pome-sh/cli twin start slack`.
>
> The rest of this file is the engineering reference: HTTP/MCP surface, seed
> shape, security model, and the runtime contract pome-cloud's sandbox images
> depend on.

`@pome-sh/twin-slack` is a local, stateful Slack twin for agent testing. It exposes Slack Web API–shaped REST routes plus an 11-tool MCP-style API backed by the same SQLite domain services. The 11 visible MCP tools mirror the canonical Slack agent toolset (post message, reply to thread, add reaction, get channel history, get thread replies, list channels, list users, get user profile, search messages, get reactions, list channel members).

## Quickstart

```bash
npx @pome-sh/cli twin start slack   # http://127.0.0.1:3333, prints the MCP URL + POME_AUTH_TOKEN
curl http://127.0.0.1:3333/healthz
```

Contributors booting from a repo checkout: see [Local commands](#local-commands).

Slack-shaped REST + MCP routes live under `/s/:sid/*` and require a
bearer token whose `sid` claim matches the URL `:sid`. `/healthz` and
`/admin/*` stay at the root (admin is localhost-only).

The CLI prints a usable `POME_AUTH_TOKEN`. To mint one by hand against a
self-booted server:

```bash
# Mint a token (32-char minimum secret recommended; use the SAME secret as the server)
TOKEN=$(node -e "import('hono/jwt').then(m => m.sign({ sid: 'demo', team_id: 'tm_1', login: 'pome-agent', exp: Math.floor(Date.now()/1000)+3600 }, process.env.TWIN_AUTH_SECRET).then(t => console.log(t)))")

# Public health probe — no auth
curl http://127.0.0.1:3333/healthz

# Session-scoped routes — auth required, sid in path must equal sid in claim
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3333/s/demo/auth.test
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3333/s/demo/mcp/tools

# Slack SDKs default to form-encoded bodies; the twin accepts both form and JSON
curl -X POST http://127.0.0.1:3333/s/demo/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'channel=C_GENERAL&text=hello'

# Legacy MCP call
curl -s -X POST http://127.0.0.1:3333/s/demo/mcp/call \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tool":"slack_list_channels","arguments":{"limit":10}}'
```

The default seed creates:

- Workspace `T_POME` ("Pome Twin Workspace", domain `pome-twin`)
- Users `pome-agent` (`U_PRIMARY`, admin), `alice` (`U_ALICE`), `bob` (`U_BOB`)
- Channels `#general` (`C_GENERAL`, all three members, 2 seeded messages) and `#random` (`C_RANDOM`, no members)

## APIs

- REST base URL: `http://127.0.0.1:3333`
- **Real MCP (JSON-RPC, Streamable HTTP, stateless):** `POST /s/:sid/mcp`
  — speaks the protocol the `@modelcontextprotocol/sdk` `Client` +
  `StreamableHTTPClientTransport` expect (`initialize`, `tools/list`,
  `tools/call`, `ping`, `notifications/*`). 11 visible tools returned via
  `tools/list` with camelCase `inputSchema`.
- Legacy custom MCP routes:
  - `GET  /s/:sid/mcp/tools` — returns `{ tools: [{ name, description, input_schema }, ...] }`
  - `POST /s/:sid/mcp/call` — body `{ tool, arguments }`

All session-scoped REST and MCP routes require a bearer token whose `sid`
claim matches the path. Provider-shape `xoxb-pome-<sid>-<sig>` /
`xoxp-pome-<sid>-<sig>` tokens are also accepted (cloud control-plane issues
these via `provider_credentials.slack.token`).

### Connecting from `@modelcontextprotocol/sdk` or the Anthropic Agent SDK

```ts
// Anthropic claude-agent-sdk mcpServers config
mcpServers: {
  slack: {
    type: "http",
    url: `${TWIN_BASE_URL}/s/${sid}/mcp`,
    headers: { Authorization: `Bearer ${token}` }
  }
}
```

The endpoint is stateless: each POST is independent; no `Mcp-Session-Id`
round-trip, no SSE. `GET` and `DELETE` on `/s/:sid/mcp` return 405. The
bearer-auth contract is unchanged — the JWT `sid` claim (or
`xoxb-pome-<sid>-<hmac>` provider-shape token) still has to match the
path's `:sid`.

### Visible MCP tools

| Tool | Inputs | Description |
|---|---|---|
| `slack_post_message` | `channel_id, text` | Post a message |
| `slack_reply_to_thread` | `channel_id, thread_ts, text` | Reply in a thread |
| `slack_add_reaction` | `channel_id, timestamp, reaction` | Add a reaction emoji |
| `slack_get_channel_history` | `channel_id` (opt `limit`) | Get channel history |
| `slack_get_thread_replies` | `channel_id, thread_ts` | Get thread replies |
| `slack_list_channels` | opt `limit`, `cursor` | List channels |
| `slack_get_users` | opt `cursor`, `limit` | List workspace users |
| `slack_get_user_profile` | `user_id` | Get user profile |

### Use in a new project

Boot the twin with the CLI and drive it over HTTP — that is the whole
integration surface:

```bash
npx @pome-sh/cli twin start slack &
curl -X POST http://127.0.0.1:3333/admin/seed -H 'content-type: application/json' -d '{}'
```

There is no supported in-process API: `createSlackTwinApp` and friends are
internal exports consumed only by this repo's own tests and the CLI.

### Claude Agent example

`examples/claude-slack-agent.ts` is a runnable end-to-end demo: it asks
Claude to plan a Slack-flavored task, then drives each tool call via the
`@modelcontextprotocol/sdk` JSON-RPC client.

```bash
TWIN_AUTH_SECRET=dev-only-insecure-secret SLACK_DETERMINISTIC_TS=1 npm run dev &
ANTHROPIC_API_KEY=sk-... npm run agent:claude "Post hello to #general and react :wave:"
```

### Local commands

Contributor-only, from a repo checkout (these scripts are not part of any
published package):

```bash
npm run seed         # seed the local DB
npm run dev          # boot the twin on :3333
npm run smoke        # 12-step end-to-end smoke test
npm run validate:mcp # JSON-RPC SDK round-trip against /s/<sid>/mcp
npm run typecheck    # tsc --noEmit
npm run test         # full vitest run
npm run test:coverage # coverage gate (lines 90%+, funcs 90%+)
npm run agent:claude "<task>"   # Claude-driven smoke flow
```

### Tracing parity

Every `tools/call` reaching `/s/:sid/mcp` produces one recorder event whose
`request_body` is `{ tool, arguments }` and whose `response_body` is the raw
domain return — identical to what `POST /s/:sid/mcp/call` records. The
only intentional difference is `path`. Run `npm run validate:mcp` to
exercise the MCP wire protocol end-to-end and dump the round-trip.

## Security model

- **Session URL vs state:** `/s/:sid` binds the bearer token to a session id in the URL. A single process uses one SQLite database for all SIDs on that instance (same model as `twin-github`). Do not run unrelated tenants in one twin process.
- **Provider tokens:** Cloud-issued tokens use `xoxb-pome-<base64url(sid)>_<sig>` (underscore delimiter, matching `twin-github`'s `ghp_pome_*` pattern). Provider tokens act as `login: pome-agent` unless the JWT carries an explicit `login` claim.
- **Private channels:** Reads (`conversations.history`, `search.messages`, etc.) require channel membership for private / IM / MPIM channels, consistent with writes.
- **Admin routes:** `/admin/reset` and `/admin/seed` are localhost-only and unauthenticated (intentional for snapshot bootstrap). Bind to `127.0.0.1` in untrusted networks.
- **Introspection:** `GET /s/:sid/_pome/state` exports the full workspace snapshot to any valid session bearer (debugging only).
- **Production:** Set `TWIN_AUTH_SECRET` when `NODE_ENV=production`; the dev fallback secret is rejected at startup.

## Runtime contract (for snapshot consumers)

`pome-cloud` builds a Vercel Sandbox snapshot from this package's signed source
artifact. The following constraints must hold for that build to succeed and for
the resulting snapshot to boot. Changing any of these is a breaking change for
hosted; land the producer change here first, then open the cloud consumer PR
that pins and verifies the new signed digest.

### Build

- Package is `npm install`-able from `package.json` alone (no `workspace:*`
  protocols, no package-manager-specific deps; no committed lockfile is required, the snapshot
  build regenerates one on each rebuild). Internal `@pome-sh/*` dependencies
  are exact published versions.
- `npm run build` exits 0 and emits `dist/src/server.js`
- Built output is loadable under Node 24 — the snapshot runs `runtime: "node24"`.

### Runtime

- Server entry: `node dist/src/server.js` (cwd = package root)
- Listens on `:3333`
- Honors `SLACK_CLONE_HOST=0.0.0.0` env (default `127.0.0.1` is unreachable
  via Vercel Sandbox port forwarding)
- `GET /healthz` returns 200 within ~3s of process start (the snapshot build
  sleeps 3s after `node dist/src/server.js` before probing)
- All admin routes are localhost-only (`/admin/*`)
- Bearer auth at `Authorization: Bearer <jwt>` — engine-owned (`@pome-sh/sdk` `bearerAuth`), shape declared in `src/twin.ts`

### Env

- `PORT` — listen port (default `3333`).
- `SLACK_CLONE_HOST` — bind host (default `127.0.0.1`; set `0.0.0.0` in sandbox).
- `SLACK_CLONE_DB` — sqlite path (default `:memory:` for tests, `.slack_clone/slack.db` for dev).
- `POME_SEED_JSON` — JSON seed. Accepts flat shape or `{slack:{seed:…}}` envelope.
- `TWIN_AUTH_SECRET` — HMAC secret for JWT + provider tokens. Required in production.
- `POME_RUN_ID` — recorder correlation id (default `spawn`).
- `SLACK_DETERMINISTIC_TS` — set to `1` for deterministic message timestamps in tests.

### Cloud consumer coordination

- Bumping any of the above = publish a signed twin digest and open the matching
  `pome-cloud` consumer PR.
- The cloud-side snapshot build script lives at
  `pome-cloud/notes/build-twin-slack-template.ts`
- The snapshot manifest at `pome-cloud/infra/twin-slack-snapshot.json`
  records the OSS git sha and signed OCI digest each snapshot was built from.
