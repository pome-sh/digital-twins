# `@pome-sh/twin-linear`

`@pome-sh/twin-linear` is a stateful digital twin of the Linear API. It stores data in SQLite and exposes GraphQL, OAuth, and 22 MCP tools.

This package is private implementation code. It is bundled with [`@pome-sh/cli`](../../cli/) and is not a separate install surface.

## Start the twin

```bash
npx @pome-sh/cli twin start linear
```

The default port is `3337`. The command prints `POME_LINEAR_REST_URL`, `POME_LINEAR_MCP_URL`, `POME_AUTH_TOKEN`, and `POME_LINEAR_TOKEN`.

```bash
curl http://127.0.0.1:3337/healthz
```

## Authentication

Pome session JWTs use the `linear_email` claim. The default email is `admin@pome-twin.test`.

Local runs also accept seeded Linear credentials. The default seed includes the personal token `lin_test_admin`. Provider-shaped tokens use the `lin_pome_` prefix.

## API

The twin serves GraphQL at `/graphql` and `/s/:sid/graphql`. MCP is also available at the root and below `/s/:sid`.

Public OAuth routes use `/oauth/authorize`, `/oauth/authorize/callback`, `/oauth/token`, and `/oauth/revoke`.

The MCP endpoint is `POST /s/:sid/mcp`. It implements stateless Streamable HTTP and exposes these tools:

```text
list_issues
get_issue
save_issue
list_comments
save_comment
delete_comment
list_teams
get_team
list_users
get_user
list_issue_statuses
get_issue_status
list_issue_labels
create_issue_label
list_projects
get_project
save_project
list_cycles
search_documentation
list_documents
get_document
save_document
```

The names, descriptions, and advertised schemas come from [`fixtures/mcp-tools-list.raw.json`](fixtures/mcp-tools-list.raw.json). Twin validators define the accepted inputs. `save_*` tools create or update records.

## Unsupported surfaces

The twin does not expose MCP tools for these families:

- initiatives, milestones, releases, and status updates
- attachments
- Git diffs and pull-request reviews
- agent skills
- project labels

Some exposed tools omit provider parameters. For example, `save_issue` omits milestone and due-date inputs through MCP.

Unsupported GraphQL operations return a clear unsupported response. External webhook delivery is not implemented.

## Fidelity and limits

[`FIDELITY.md`](FIDELITY.md) records GraphQL and MCP fidelity. [`fidelity.inventory.json`](fidelity.inventory.json) contains the machine-readable inventory.

[`REFERENCE-DIVERGENCES.md`](REFERENCE-DIVERGENCES.md) records differences from the rejected reference implementation. [`LIMITS.md`](LIMITS.md) records seed, GraphQL, MCP, and state limits.

[`CONTRACT.md`](../../CONTRACT.md) defines the shared boot and runtime requirements.

## Contributor commands

Run package scripts from `packages/twin-linear`:

```bash
npm run dev
npm run typecheck
npm run fidelity:parity
npm run gate:mcp-fixture
```

Run this test command from the repository root:

```bash
npx vitest run --project twin-linear
```

To update the captured MCP listing, use the repository capture process. Do not edit the tool table in TypeScript.
