---
"@pome-sh/cli": minor
---

Re-pinned the bundled `@pome-sh/*` packages to the packages-v30 batch:
shared-types 0.14.0, sdk 0.11.0, the five twins.

These are `bundleDependencies`, frozen into the tarball at publish time rather
than resolved at install, so the re-pin only reaches users through a CLI
version bump. The batch carries the F-1200 parent-vocabulary change: a recorded
row now names the tool call that caused it via `parent_event_id`, and the
CLI's post-run merge resolves that parent.
