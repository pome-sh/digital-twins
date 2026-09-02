# `@pome-sh/twin-github`

`@pome-sh/twin-github` is a stateful digital twin of the GitHub API. It stores data in SQLite and exposes GitHub-shaped REST routes and 36 MCP tools.

This package is private implementation code. It is bundled with [`@pome-sh/cli`](../../cli/) and is not a separate install surface.

## Start the twin

```bash
npx @pome-sh/cli twin start github
```

The command starts the twin in the foreground. It prints these client values:

- `POME_GITHUB_REST_URL`
- `POME_GITHUB_MCP_URL`
- `POME_AUTH_TOKEN`

Check the server from another terminal:

```bash
curl http://127.0.0.1:3333/healthz
```

The default seed contains the `acme/api` repository, its `main` branch, files, labels, users, and issue `#1`.

## API

Session routes use `/s/:sid/*`. The bearer token must contain the same `sid` as the URL.

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Unauthenticated process health |
| `POST /s/:sid/mcp` | Stateless MCP over Streamable HTTP |
| `GET /s/:sid/mcp/tools` | Legacy HTTP tool listing |
| `POST /s/:sid/mcp/tools/:name` | Legacy per-tool HTTP call |
| `POST /s/:sid/mcp/call` | Legacy call with `{ tool, arguments }` |
| `GET /s/:sid/_pome/state` | Redacted domain state |
| `GET /s/:sid/_pome/events` | Recorded events |
| `POST /admin/reset` | Reset state through the admin gate |
| `POST /admin/seed` | Apply a seed through the admin gate |

The MCP endpoint supports `initialize`, `tools/list`, `tools/call`, `ping`, and notifications. It does not use MCP session IDs or SSE.

[`fixtures/mcp-tools-list.raw.json`](fixtures/mcp-tools-list.raw.json) defines the served tool listing.

Use the values printed by the CLI:

```bash
export POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone
export POME_AUTH_TOKEN='<token printed by pome twin start>'

curl -H "Authorization: Bearer $POME_AUTH_TOKEN" \
  "$POME_GITHUB_REST_URL/repos/acme/api/issues/1"

curl -s -X POST "$POME_GITHUB_REST_URL/mcp/call" \
  -H "Authorization: Bearer $POME_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tool":"search_repositories","arguments":{"query":"acme"}}'
```

An MCP client can use the JSON-RPC endpoint directly:

```ts
mcpServers: {
  github: {
    type: "http",
    url: `${TWIN_BASE_URL}/s/${sid}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  },
}
```

## Seed data

Pass a seed file to the CLI:

```bash
npx @pome-sh/cli twin start github --seed ./github-seed.json
```

You can also apply a seed through the local admin route:

```bash
curl -s -X POST http://127.0.0.1:3333/admin/seed \
  -H 'content-type: application/json' \
  -d '{
    "users": [
      { "login": "my-org", "type": "Organization", "name": "My Org" },
      { "login": "agent-user", "type": "User", "name": "Agent User" }
    ],
    "repositories": [
      {
        "owner": "my-org",
        "name": "my-app",
        "default_branch": "main",
        "collaborators": ["agent-user"],
        "files": [
          { "path": "README.md", "content": "# My App\n" }
        ],
        "issues": [
          { "number": 1, "title": "Fix checkout error", "labels": [], "assignees": [] }
        ]
      }
    ]
  }'
```

Seeded issue and pull-request numbers share one repository counter. A tag target can be a branch name or commit SHA.

GitHub creates missing author, assignee, and collaborator logins as users. Review-comment paths and lines must refer to changed files.

## Fidelity

[`FIDELITY.md`](FIDELITY.md) records MCP and REST fidelity, measured differences, and evidence. [`fidelity.inventory.json`](fidelity.inventory.json) contains the machine-readable inventory.

Tests should assert final behavior instead of generated identifiers. For example, assert that a pull request merged and that its file exists on `main`.

## Runtime contract for snapshot consumers

[`CONTRACT.md`](../../CONTRACT.md) defines the entry point, environment variables, health response, authentication, and shared routes.

Treat a change to that contract as breaking. Update the contract and its black-box tests in the same pull request.

Pome maintainers must then publish a signed twin artifact. They must also update and verify the matching `pome-cloud` pin.

## Contributor commands

Run package scripts from `packages/twin-github`:

```bash
npm run dev
npm run seed
npm run typecheck
npm run smoke
npm run fidelity:parity
npm run validate:mcp
npm run review:harness
npm run agent:claude
```

Run this test command from the repository root:

```bash
npx vitest run --project twin-github
```

`npm run capture:fixtures` refreshes sanitized GitHub response fixtures. It requires GitHub CLI authentication.
