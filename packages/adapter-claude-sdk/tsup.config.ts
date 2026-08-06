// SPDX-License-Identifier: Apache-2.0
//
// The adapter is the second of the two packages published to npm. It bundles
// its internal `@pome-sh/*` dependency — the wire types + redaction helpers —
// via `noExternal`. `@pome-sh/wire` IS published (F-949), but to GitHub
// Packages, which requires a GitHub token even to read; declaring it as a real
// dependency would 401 on an end user's `npm i`. Bundling is what keeps wire out
// of their install graph, so `noExternal` must stay.
//
// Everything else stays external and stays a real dependency: the OpenTelemetry
// packages (a consumer's app almost certainly has its own OTel SDK, and two
// copies of `@opentelemetry/api` means two independent context managers, so
// spans silently stop nesting), `zod` (schema identity again), and
// `@anthropic-ai/claude-agent-sdk`, which is a required peer.
//
// `dts: true` matters here in a way it does not for the CLI: consumers import
// `HookEvent` and friends, and those types come from the bundled wire package.
// If dts bundling drops or mis-resolves them the runtime import still succeeds
// and only the consumer's `tsc` breaks — so the pack test compiles a real
// consumer file, it does not just import the module (D11 / outside-voice #8).
//
// VERSIONED INDEPENDENTLY of the CLI (D11): the adapter tracks its own 0.2.x
// line and `release.yml` publishes it only when its own version differs from
// the registry.
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  treeshake: true,
  noExternal: [/^@pome-sh\//],
  // See cli/tsup.config.ts: tsup 8 strips the `node:` prefix by default, which
  // turns builtin imports into bare specifiers that do not resolve.
  removeNodeProtocol: false,
});
