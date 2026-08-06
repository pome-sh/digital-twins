// SPDX-License-Identifier: Apache-2.0
//
// `@pome-sh/checks` is the third npmjs-published package, and the only one whose
// entire reason to exist is a CROSS-REPO consumer: pome-cloud grades every
// `[code]` criterion out of these declarations (F-1308).
//
// ── Why it bundles instead of depending ──────────────────────────────────────
//
// The declarations live in `packages/twin-*/src/check-*.ts` and
// `packages/sdk/src/checks.ts`, and those packages are `private: true` and stay
// that way — commit 6369379 privatised them to fix a real bug (two zod schema
// identities for one wire type, F-942) and F-1308 is explicit that it is not
// being reversed. So this package cannot DEPEND on them; it inlines their
// compiled output via `noExternal`, exactly as `@pome-sh/cli` and
// `@pome-sh/adapter-claude-sdk` already do.
//
// That also settles a pin question with no good answer. AGENTS.md forbids exact
// `@pome-sh/*` pins between internal packages (the F-942 rule); `"*"` in a
// PUBLISHED manifest is unbounded at the consumer's install time; and `^0.x` is
// rejected by `scripts/check-workspace-pins-match-workspace.mjs`. Bundling means
// there is no pin to pick, because the published `package.json` declares zero
// `@pome-sh/*` runtime dependencies. `scripts/ci/check-checks-tarball.mjs`
// asserts that.
//
// ── zod stays EXTERNAL, and that is the whole point ──────────────────────────
//
// zod is a `peerDependency`, never bundled. The seed schemas and `defineCheck`
// are zod values, and pome-cloud parses seeds it built with its OWN zod. Two
// copies of zod means two schema identities — `instanceof` fails, `.parse()`
// results stop being interchangeable — which is precisely the F-942 bug that
// dissolved `@pome-sh/shared-types`. A peer dependency is what guarantees the
// consumer's graph holds exactly one zod.
//
// ── splitting: true is load-bearing, not a size tweak ────────────────────────
//
// Seven entries all reach `@pome-sh/sdk/checks`. Without code splitting each
// entry would carry its own copy of `defineCheck`, `statePath` and the
// `VACUITY_SENTINEL` constants, so `@pome-sh/checks/github`'s `defineCheck` and
// `@pome-sh/checks/stripe`'s would be different function objects backing
// different closures. Same argument as zod, one layer in. Shared chunks keep it
// to one copy; `test/one-copy.test.ts` asserts it.
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    dsl: "src/dsl.ts",
    github: "src/github.ts",
    gmail: "src/gmail.ts",
    linear: "src/linear.ts",
    slack: "src/slack.ts",
    stripe: "src/stripe.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  // Consumers import these types — `Check`, `CheckDefinition`, the per-twin
  // check-state shapes and the parsed-seed types are the surface pome-cloud
  // typechecks `resolveTwinChecks` against. A dts rollup that silently drops a
  // type still imports fine at runtime and only breaks the consumer's `tsc`,
  // which is why the tarball gate compiles a real consumer file rather than
  // just importing the module.
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: false,
  treeshake: true,
  noExternal: [/^@pome-sh\//],
  // See cli/tsup.config.ts: tsup 8 strips the `node:` prefix by default, which
  // turns `node:crypto` (used by the check digest and stripe's id helpers) into
  // a bare `"crypto"` that does not resolve.
  removeNodeProtocol: false,
});
