---
"pome-sh": patch
---

`pome run --local` now serves the engine-based Slack twin: the twin-core
engine (`@pome-sh/sdk`) is vendored as `cli/vendor/pome-sh-sdk-0.2.0.tgz`
(dependencies + overrides + `bundleDependencies`, the same exact-version
hoist mechanism as `@pome-sh/shared-types`), and the vendored
`@pome-sh/twin-slack` tarball is refreshed to the F-683 defineTwin() port —
its `workspace:*` sdk dep resolves against the hoisted vendored engine.
Zero wire diff: healthz/auth/MCP/admin shapes are pinned by the frozen
runtime contract (CONTRACT.md, FDRS-711).

The CLI's recorder/redaction copy (`cli/src/recorder/redaction.ts`) is
deleted (F-713); every write site (artifacts, capture-server, eval upload,
hosted upload, fix-prompt, adapter-signals merge) now imports
`redactEvent`/`redactSecrets` from the vendored `@pome-sh/sdk`, so the CLI
ships the engine's redactor instead of a byte-mirror. Behavior is unchanged
(the mirror was functionally identical; only comments differed).
