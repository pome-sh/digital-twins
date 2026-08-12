<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/wire — CHANGELOG

## 0.2.2 — 2026-08-12

No schema, type, export or behaviour change. F-1488 fixed
`scripts/emit-trace-contract.mjs`'s entry guard: it compared
`process.argv[1]` against `import.meta.url` with no `realpathSync` on either
side, so the guard fell false and the script exited 0 having emitted nothing
when reached through a symlinked checkout (a `git worktree`, or macOS's
symlinked `/tmp`). Both sides are realpath'd now, and a guard miss while
invoked as this file throws rather than exits 0.

The script itself is dev tooling that ships in no tarball, but its OUTPUT does:
`trace-contract.json` is in this package's `files` array and embeds the package
version, so the bump changes one byte of the published artifact and
`check:trace-contract` (wired in both ci.yml and release.yml) reds until it is
re-emitted. The bump is therefore self-justifying, not the packaging-only kind
0.2.1 was.

Wire had no changelog before 0.2.1 because it had never been published. Earlier
versions exist only as bytes inlined into `@pome-sh/cli` and
`@pome-sh/adapter-claude-sdk`; their history is in those packages' changelogs.

## 0.2.1 — 2026-08-06

**First published version.** Packaging only — no schema, type, export or
behaviour change from 0.2.0.

`@pome-sh/wire` was `private: true` and reached the outside world only as bytes
tsup inlined into `@pome-sh/cli` and `@pome-sh/adapter-claude-sdk`. It is now
also published as an independently versioned artifact to **GitHub Packages**
(`npm.pkg.github.com`), for consumers in other repositories — today
`pome-sh/pome-cloud`, which speaks the same trace vocabulary and had been
reaching it across a repo boundary through npm-installed internal packages
(F-949).

- `private: true` → `private: false`; added
  `publishConfig.registry: https://npm.pkg.github.com`. It is **not** on npmjs
  and is not an end-user install surface — reading it requires a GitHub token.
- `README.md` added to the `files` field so the published package has a readme.
- `!dist/**/*.map` added to `files`. `tsconfig.json` sets `sourceMap: true` and
  no `src/` ships, so every emitted `.js.map` was a dangling map with no
  `sourcesContent` — 14 of them. `scripts/clean-room-pack-test.mjs` already
  treats a dangling map in a published tarball as a hard failure for the other
  two packages (F-943); wire's tarball now holds to the same rule. Local builds
  keep their maps.
- Published by the new `publish-wire` job in `.github/workflows/release.yml`,
  on the same version-diff-on-push model as the two npm packages but with
  `GITHUB_TOKEN` auth instead of npm OIDC Trusted Publishing.
- `trace-contract.json` moves by exactly one line: it embeds wire's own
  `version`, so `check:trace-contract` fails on any version bump until
  `emit:trace-contract` is re-run. Every future wire release must regenerate it
  in the same commit.

**The bundled path is unchanged.** `cli/` and `packages/adapter-claude-sdk/`
still declare wire as a `devDependency` at `"*"` and tsup's
`noExternal: [/^@pome-sh\//]` still inlines it, so neither published npm
tarball has an `@pome-sh/wire` dependency and no end user ever resolves it from
a registry. Do not turn wire into a runtime dependency of either: GitHub
Packages requires auth to read, so an end user's `npm i` would 401.

Verified from outside the workspace before release: the packed tarball installs
into a bare directory with `zod` as its only peer, all six subpath exports
import, and a consumer typechecks against the shipped declarations under
`NodeNext` without `skipLibCheck`.
