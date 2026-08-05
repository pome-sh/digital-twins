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

## Extract framework-agnostic trace correlation

`packages/adapter-claude-sdk/src/{fetch,als}.ts` carries the
`x-pome-correlation-id` injection and the AsyncLocalStorage plumbing that make
per-tool-call correlation race-proof. Only the `tool()` / `query()` wrapping
around it is Claude-specific. Split the correlation core into a
framework-neutral module so Vercel AI SDK and LangGraph agents get the same
guarantee instead of re-deriving it.

Depends on: the `@pome-sh/wire` package (landed in F-942).
