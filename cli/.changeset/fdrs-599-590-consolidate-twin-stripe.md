---
"pome-sh": patch
---

`pome run --local` now serves the packaged Stripe twin (`@pome-sh/twin-stripe`,
vendored as `cli/vendor/pome-sh-twin-stripe-0.1.0.tgz` + `bundleDependencies`)
instead of a divergent in-CLI copy. The CLI's `cli/src/twin-stripe` fork is
deleted, so local runs and Docker runs now execute byte-identical Stripe twin
logic (FDRS-599, FDRS-590) — including the JSON-RPC `/mcp` surface and the
refund tool family that had previously only existed in one copy. No behavior
change for CLI users beyond the local/Docker parity fix.
