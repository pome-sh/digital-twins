---
"@pome-sh/cli": minor
---

`pome checks slack` answers with Slack's five declared checks; slack leaves the
not-yet-migrated list. `pome checks <twin>` now also prints the digest instead
of only computing it, so an author who hits `checks add`'s skew refusal can see
which side moved.

`bundleDependencies` bakes the moved `@pome-sh/*` pins into the tarball, so this
is a shipping change and needs a changeset of its own.
