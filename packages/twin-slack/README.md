# `@pome-sh/twin-slack`

`@pome-sh/twin-slack` is a stateful digital twin of the Slack Web API. It uses SQLite and exposes Slack-shaped REST routes and 18 MCP tools.

This package is private implementation code. It is bundled with [`@pome-sh/cli`](../../cli/) and is not a separate install surface.

## Start the twin

```bash
npx @pome-sh/cli twin start slack
```

The command prints `POME_SLACK_REST_URL`, `POME_SLACK_MCP_URL`, and `POME_AUTH_TOKEN`.

```bash
curl http://127.0.0.1:3333/healthz
```

The default seed contains workspace `T_POME`, three users, and the `general` and `random` channels.

## API

Session routes use `/s/:sid/*`. The bearer token must contain the same `sid` as the URL.

Slack SDKs can send form-encoded bodies. The twin accepts form-encoded and JSON bodies on Slack REST routes.

```bash
export POME_SLACK_REST_URL=http://127.0.0.1:3333/s/standalone
export POME_AUTH_TOKEN='<token printed by pome twin start>'

curl -X POST "$POME_SLACK_REST_URL/chat.postMessage" \
  -H "Authorization: Bearer $POME_AUTH_TOKEN" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'channel=C_GENERAL&text=hello'

curl -s -X POST "$POME_SLACK_REST_URL/mcp/call" \
  -H "Authorization: Bearer $POME_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tool":"slack_search_channels","arguments":{"query":"general","limit":10}}'
```

The JSON-RPC MCP endpoint is `POST /s/:sid/mcp`. It implements stateless Streamable HTTP.

Legacy HTTP endpoints remain available at `GET /s/:sid/mcp/tools` and `POST /s/:sid/mcp/call`.

## MCP tools

The twin exposes these 18 tools:

```text
slack_send_message
slack_schedule_message
slack_add_reaction
slack_create_conversation
slack_create_canvas
slack_update_canvas
slack_search_public
slack_search_public_and_private
slack_search_channels
slack_search_users
slack_read_channel
slack_read_thread
slack_read_canvas
slack_read_user_profile
slack_list_channel_members
slack_read_file
slack_search_emojis
slack_get_reactions
```

The names, descriptions, and schemas come from Slack's captured MCP listing in [`fixtures/mcp-tools-list.raw.json`](fixtures/mcp-tools-list.raw.json).

Slack also declares `slack_send_message_draft`. This twin does not expose that tool. See [`docs/slack-mcp-unexposed-tools.md`](../../docs/slack-mcp-unexposed-tools.md).

## Seeded files

A seed can add files for `files.list`, `files.info`, and `slack_read_file`:

```json
{
  "files": [
    {
      "id": "F_RUNBOOK",
      "name": "runbook.md",
      "title": "Incident runbook",
      "filetype": "markdown",
      "user": "alice",
      "channels": ["general"],
      "content": "# Runbook\n1. Page the on-call.\n"
    }
  ]
}
```

`user` and `channels` accept seeded names or IDs. The twin derives `mimetype` from `filetype` and `size` from `content`.

## Security

- `/admin/reset` and `/admin/seed` use the shared admin gate.
- Private conversations require membership for reads and writes.
- `GET /s/:sid/_pome/state` requires a valid session bearer.
- Production mode requires `TWIN_AUTH_SECRET`.
- One process uses one SQLite database for all session IDs. Do not place unrelated tenants in one process.

## Fidelity

[`FIDELITY.md`](FIDELITY.md) records REST and MCP fidelity for each surface. [`fidelity.inventory.json`](fidelity.inventory.json) contains the machine-readable inventory.

[`CONTRACT.md`](../../CONTRACT.md) defines the shared boot and runtime requirements.

## Contributor commands

Run package scripts from `packages/twin-slack`:

```bash
npm run dev
npm run seed
npm run smoke
npm run validate:mcp
npm run typecheck
npm run test:coverage
npm run fidelity:parity
npm run agent:claude -- "Post hello to #general"
```

Run this test command from the repository root:

```bash
npx vitest run --project twin-slack
```
