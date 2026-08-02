---
"@pome-sh/cli": minor
---

BREAKING: the bundled Linear twin moves to `@pome-sh/twin-linear` 0.3.0, whose
`AgentSession` uses Linear's real field names.

`@pome-sh/twin-linear` is a `bundleDependencies` entry, so the pin is baked into
the CLI tarball and this re-pin is what actually delivers 0.3.0 to anyone running
`pome`. The twin declared `state`, `externalUrl` and `agentUser` — three names
Linear does not have — so an agent written against real Linear read `undefined`
from the twin, and an agent written against the twin broke in production. They
are now `status` (a real `AgentSessionStatus` enum), `externalUrls` (a collection
of `{ url, label }`) and `appUser`, alongside `id: ID!`, `createdAt` /
`updatedAt: DateTime!` and `plan: JSON`. There is no alias and no deprecation
window: a twin carrying both names would still expose a field Linear does not
declare, which is the defect.

Two consequences for a CLI user. Any task, seed or check that names the old
fields must be renamed — including in the `/_pome/state` export the checks read
and in the `AgentSessionEvent` webhook payload. And an existing `LINEAR_TWIN_DB`
file is migrated in place the first time this CLI opens it: `agent_sessions`
renames `agent_user_id` → `app_user_id` and `state` → `status`, adds
`external_urls_json` backfilled from `external_url`, and rewrites the three
retired status values (`completed` → `complete`, `failed` → `error`,
`canceled` → `stale`). The migration is idempotent, but there is no downgrade —
an older CLI cannot read a migrated database.

The same pin also carries F-1166: partial updates no longer wipe fields the
caller never mentioned. Nullable fields are tri-state — key absent or present
with `undefined` leaves the value alone, `null` clears it — which fixes
`agentSessionUpdate`, `issueUpdate`, `issueLabelUpdate`, `updateProject`,
`updateDocument` and the MCP `save_issue` / `save_project` / `save_document`
tools, plus an `issueUpdate` with an explicit `stateId: null` erasing an issue's
lifecycle timestamps.
