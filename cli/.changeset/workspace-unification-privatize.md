---
"@pome-sh/cli": minor
---

Unify the CLI into the root npm workspace and privatize internal `@pome-sh/*` packages.

Internal packages resolve via workspace `"*"` pins instead of exact registry versions, so the CLI and twins share one schema identity. Publishing stays frozen until the tsup release path lands; this bump records the workspace-unification shipping change for the next publish.
