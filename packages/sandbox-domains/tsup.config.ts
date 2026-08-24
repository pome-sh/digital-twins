// SPDX-License-Identifier: Apache-2.0
//
// `@pome-sh/sandbox-domains` is the fifth npmjs-published package, and the second
// whose entire reason to exist is a CROSS-REPO consumer: pome-cloud boots this
// in-process as the grading/authoring runtime (`lib/twin-state.ts`), and
// `checks-package-drift.test.ts` compares its binding surface against
// `@pome-sh/checks`'s, per twin, with no allowlist.
//
// ── Why a bundle, and why now ────────────────────────────────────────────────
//
// The twins and the sdk are `private: true` and stay that way — commit 6369379
// privatised them to fix two zod schema identities for one wire type,
// and that is not being reversed. That left the drift
// gate's two legs on different clocks: `@pome-sh/checks` could publish a
// widened vocabulary, and the runtime leg pome-cloud actually booted had no
// publish lane at all, so a red gate had NO legal move. This package is the
// runtime leg's lane, in the one shape the lane already knows how to ship: a
// self-contained bundle with zero `@pome-sh/*` runtime dependencies.
//
// Published under the allocator alongside `@pome-sh/checks`, so both
// legs are cut from the SAME `main` commit and their binding surfaces agree by
// construction rather than by anyone remembering to publish two things.
//
// ── What it is NOT ───────────────────────────────────────────────────────────
//
// This is the DOMAIN layer, not the twin server. `@pome-sh/checks` ships the
// declarations, this ships what those declarations read: `{Twin}Domain`,
// `open*Database`, `parseSeed`/`applySeed`, plus each twin's `*_CHECKS` so a
// consumer can bind a criterion without also installing the vocabulary package.
// The standalone HTTP twin's channel is GHCR and stays GHCR (ADR-021) — nothing
// here is a route table or an MCP tool listing.
//
// ── zod stays EXTERNAL, and that is the whole point ──────────────────────────
//
// Same argument as `packages/checks/tsup.config.ts`, and it binds harder here:
// pome-cloud hands `parseSeed` a seed it built with its OWN zod, and the parsed
// result is what the domain then writes into SQLite. Two zod copies means two
// schema identities — `instanceof` fails, `.parse()` results stop being
// interchangeable — the bug that dissolved `@pome-sh/shared-types`. A
// peerDependency is what guarantees the consumer's graph holds exactly one zod.
//
// ── hono is an ORDINARY dependency here, and that is the difference ──────────
//
// `check-checks-tarball.mjs` treats a `hono` byte as a FAILURE, because a
// declarations-only package shipping an HTTP server means something reached
// `@pome-sh/sdk/server` where a narrow subpath would do. This package is the
// opposite case: `./server` deliberately re-exports `toTwinHttpEventRow` from
// `@pome-sh/sdk/server` (the only subpath that exports it), and each twin's
// domain arrives through its package root, which is also where `defineTwin()`
// runs at module scope. So hono is a real, declared, EXTERNAL dependency — not
// inlined, not forbidden. The tarball gate asserts the final dependency set
// either way rather than either of us assuming it: `@hono/node-server` was
// declared here too until that gate reported nothing imports it, and `graphql`
// was declared until it reported tsup had inlined it.
//
// ── Why knip.json has to ignore three of them ────────────────────────────────
//
// `hono`, `@octokit/openapi-types` and `stripe` are reachable only through the
// BUNDLE, never from `src/` — every file under `src/` is `export … from
// "@pome-sh/twin-*"` lines, and it is the inlined twin code that imports hono
// and the inlined twin DECLARATIONS that name the two upstream shape anchors
// (`GitHubDomain.pullRequestStack()`, `StripeDomain`'s `PaymentIntent[…]`
// fields). knip reads the source graph, so it cannot see any of that — and its
// verdict was ORDER-DEPENDENT before `knip.json` named them: green on a tree
// where `packages/twin-*/dist` happened to be built and knip could follow into
// it, red on CI, where `lint:dead-code` runs straight after `npm ci` with no
// `dist` anywhere.
//
// The assertions that really hold these three are on the ARTIFACT and are
// stronger than a source scan: `scripts/ci/check-sandbox-domains-tarball.mjs`
// requires every bare specifier in the shipped JS and `.d.ts` to be a declared
// dependency AND every declared dependency to be imported, and the
// sandbox-domains room in `scripts/clean-room-pack-test.mjs` installs the
// tarball with nothing beside it but zod, typescript and `@types/node`, then
// typechecks a consumer with `skipLibCheck` OFF. Dropping one of these there is
// a red; dropping it from knip's view is silence.
//
// `zod` is deliberately NOT in that ignore list: `test/surface.test.ts` imports
// it to assert the peer identity from the consumer's side, so it is
// genuinely used and knip is right to want to see it.
//
// ── splitting: true is load-bearing, not a size tweak ────────────────────────
//
// Seven entries all reach `@pome-sh/sdk`. Without code splitting each entry
// would carry its own copy of the sdk's db layer, so `@pome-sh/sandbox-domains/
// github`'s `openTwinDatabase` and `.../stripe`'s would be different function
// objects opening different `DatabaseSync` handles behind different closures.
// Same argument as zod, one layer in.
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    github: "src/github.ts",
    gmail: "src/gmail.ts",
    linear: "src/linear.ts",
    slack: "src/slack.ts",
    stripe: "src/stripe.ts",
    server: "src/server.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  // Consumers typecheck against these: `lib/twin-state.ts` types its per-twin
  // boot record against `{Twin}Domain` and the parsed-seed shapes, and the
  // drift test reads each `*_CHECKS` element's declared fields.
  //
  // `dts: true` alone emits BROKEN declarations — `noExternal` governs the JS
  // bundle only, so the declaration bundler leaves `export … from
  // "@pome-sh/twin-github"` verbatim in `dist/github.d.ts`, a specifier that
  // resolves nowhere for a consumer because that package is `private: true`.
  // `scripts/bundle-declarations.mjs` (shared with `@pome-sh/checks`, sequenced
  // after tsup by this package's `build` script) is what makes the output
  // self-contained; its header records why `dts: { resolve: … }` cannot.
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: false,
  treeshake: true,
  noExternal: [/^@pome-sh\//],
  // See cli/tsup.config.ts: tsup 8 strips the `node:` prefix by default, which
  // turns `node:sqlite` — the driver every `open*Database` opens — into
  // a bare `"sqlite"` that resolves nowhere.
  removeNodeProtocol: false,
});
