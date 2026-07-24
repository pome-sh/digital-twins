---
"@pome-sh/cli": minor
---

Gmail seeds accept the new opt-in `faults` field (named fault primitives, e.g. `rate-limited`) — the bundled `@pome-sh/shared-types` is now 0.12.2 and the bundled Gmail twin 0.2.0, so `pome run` no longer rejects fault seeds with `unrecognized_keys: ["faults"]`.
