# TODOS

Approved follow-up work that is deliberately out of scope for the packaging
restructure (`@pome-sh/cli` + `@pome-sh/adapter-claude-sdk` as the only
published packages). Each entry names its blocking dependency.

## Migrate pome-cloud off npm-installed internal packages

`pome-cloud` npm-installs frozen exact pins of packages that are now `private:
true` here: `@pome-sh/twin-github@0.1.2`, `@pome-sh/twin-gmail@0.1.1`,
`@pome-sh/twin-linear@0.1.0`, `@pome-sh/twin-slack@0.1.2`,
`@pome-sh/sdk@0.4.0`, `@pome-sh/shared-types@0.12.1`. Those published versions
stay on npm and keep resolving, so nothing breaks today — but the pins can
never move again from this repo.

Consumers to migrate: `apps/{mcp,control-plane}` and
`packages/{auth,correlator,db,replay-core,otel-ingest}` in pome-cloud. GHCR
(`ghcr.io/pome-sh/twins:<twin>`) is already the runtime channel for the twins
themselves, so the remaining need is types only — publish the wire types via
GitHub Packages rather than public npm.

Depends on: the npm-deprecation lane and the tsup/release lane of the
restructure landing first.

## Extract framework-agnostic trace correlation — DONE (F-950)

The core is now `@pome-sh/wire/correlation` (subpath-only): the
AsyncLocalStorage store (`withCorrelation` / `currentToolCallId`), the
`x-pome-correlation-id` fetch injection, and the fallback id minter. The
adapter's `src/{als,fetch,ids}.ts` are gone; what stayed Claude-specific is
`readSdkToolUseId` plus the `tool()` / `query()` wrappers.

No Vercel AI SDK or LangGraph adapter was built — that remains open, and the
point of this ticket was that it no longer has to re-derive the plumbing.

Still duplicated, deliberately out of F-950's scope: the header NAME. Both sides
of this wire protocol hardcode the literal `"x-pome-correlation-id"` — the agent
side now once, in `packages/wire/src/correlation/fetch.ts`, but the recorder side
five more times (`packages/sdk/src/{recorder,mcp-jsonrpc,failure-injection}.ts`,
`packages/twin-stripe/src/{session,idempotency}.ts`,
`packages/twin-stripe/src/routes/_helpers.ts`). Those files already depend on
wire; pointing them at `CORRELATION_HEADER` would make the constant single-source
across the protocol. A rename today still needs a grep.
