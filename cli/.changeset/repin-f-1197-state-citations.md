---
"@pome-sh/cli": patch
---

Re-pin the bundled twins and sdk onto packages-v29, so `pome checks` can see the state citations.

The batch: `@pome-sh/sdk` 0.10.1, `@pome-sh/twin-github` 0.8.1,
`@pome-sh/twin-gmail` 0.3.1, `@pome-sh/twin-linear` 0.3.1,
`@pome-sh/twin-slack` 0.3.1, `@pome-sh/twin-stripe` 0.4.2.

F-1197 gives every state-reading check a `CheckOutcome.evidenceStatePaths` — RFC
6901 pointers into the twin's exported state tree, saying which field the verdict
was read off. 37 of the 45 declared checks could previously cite nothing at all,
because only a `substrate: "tape"` check can fill `evidenceEventIds`.

This is a re-pin rather than a `cli/src/**` change, and it still needs a release:
these six are `bundleDependencies`, frozen into the tarball at publish time
rather than resolved at install, so without a version bump the moved pin never
reaches anyone. F-1132 is the six hours that rule was learned in.

No CLI behaviour changes. `checksDigest` hashes `{id, substrate, pattern}` only
and none of those moved, so `pome checks` renders the same sentences and
`vocabulary-skew` sees no drift against a cloud on the same batch.
