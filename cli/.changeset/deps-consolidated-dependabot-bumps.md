---
"pome-sh": patch
---

Bump CLI runtime and dev dependencies: `@anthropic-ai/sdk` 0.98 → 0.109,
`@hono/node-server` 1.19 → 2.0, `commander` 14 → 15, `@types/node` 22 → 26,
and `typescript` held at 5.9.3. Consolidates the pending Dependabot bumps that
verified green (typecheck, build, full test suite). TypeScript 6.0 was
intentionally skipped — it regresses `@types/node` resolution under `NodeNext`
in the workspace packages.
