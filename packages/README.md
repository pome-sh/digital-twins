# Packages

This directory contains the workspace packages used by Pome.

A digital twin emulates one provider API. A sandbox is the container that runs a twin for a user. These concepts are not interchangeable.

End users run twins through [`@pome-sh/cli`](../cli/):

```bash
npx @pome-sh/cli twin start github
```

The CLI contains the GitHub, Slack, Stripe, Gmail, and Linear twins. Their MCP surfaces expose 36, 18, 26, 13, and 22 tools respectively.

## Package map

| Directory | Package | Purpose | Distribution |
| --- | --- | --- | --- |
| [`checks/`](checks/) | `@pome-sh/checks` | Check declarations, seed schemas, default seeds, and the check DSL | npm |
| [`sandbox-domains/`](sandbox-domains/) | `@pome-sh/sandbox-domains` | In-process domain objects, SQLite openers, seed parsers, and checks | npm |
| [`wire/`](wire/) | `@pome-sh/wire` | Trace schemas, redaction, OpenTelemetry types, and correlation | GitHub Packages only |
| [`sdk/`](sdk/) | `@pome-sh/sdk` | HTTP, auth, recording, MCP dispatch, and SQLite support for twins | Private; bundled with the CLI |
| [`twin-github/`](twin-github/) | `@pome-sh/twin-github` | GitHub REST and MCP twin | Private; bundled with the CLI |
| [`twin-slack/`](twin-slack/) | `@pome-sh/twin-slack` | Slack Web API and MCP twin | Private; bundled with the CLI |
| [`twin-stripe/`](twin-stripe/) | `@pome-sh/twin-stripe` | Stripe REST, MCP, and x402 twin | Private; bundled with the CLI |
| [`twin-gmail/`](twin-gmail/) | `@pome-sh/twin-gmail` | Gmail REST and MCP twin | Private; bundled with the CLI |
| [`twin-linear/`](twin-linear/) | `@pome-sh/twin-linear` | Linear GraphQL, OAuth, and MCP twin | Private; bundled with the CLI |

The private packages are implementation workspaces. Do not publish or document them as separate install surfaces.

`@pome-sh/wire` is not published to npm. The CLI bundles it, so CLI users do not need GitHub Packages credentials.

## Dependency rules

Use `"*"` for every internal `@pome-sh/*` dependency:

```json
{
  "dependencies": {
    "@pome-sh/sdk": "*",
    "@pome-sh/wire": "*"
  }
}
```

Workspace linking resolves these dependencies. An exact internal version can install a second package copy and create incompatible Zod schema identities.

Published packages declare `zod` as a peer dependency. Do not bundle it.

## Twin registration

[`cli/src/twin/registry.ts`](../cli/src/twin/registry.ts) defines the supported twin names, ports, seed parsers, versions, and boot functions.

Each twin README documents its API surface and contributor commands. Each [`FIDELITY.md`](twin-github/FIDELITY.md) records measured behavior and known differences from the provider API.

All twins implement the shared [`CONTRACT.md`](../CONTRACT.md).
