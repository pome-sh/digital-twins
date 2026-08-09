# Reference divergences — Emulate is not an oracle

Emulate’s Linear package may be used as a **coverage checklist**. It is **never** a behavioral oracle for `@pome-sh/twin-linear`.

## Oracles

1. The MCP tool table this twin serves → [`fixtures/mcp-tools-list.raw.json`](fixtures/mcp-tools-list.raw.json) (+ `.meta.json`, `.canonical.json`). Documented Linear names, twin-owned schemas, never compared to `https://mcp.linear.app/mcp` — see the fixtures README.
2. Frozen GraphQL operation inventory → [`fixtures/graphql-surface.json`](fixtures/graphql-surface.json)
3. Linear public GraphQL / OAuth / webhook docs
4. `@linear/sdk` smoke tests against root `/graphql`
5. This package’s invariants (SQLite, seed clock, null state_delta on no-ops, loud 501)

## Explicitly rejected Emulate-known behaviors

| Rejected behavior | Twin rule |
| --- | --- |
| In-memory Store nondeterminism | SQLite + deterministic ids from seed clock / sequences |
| HTML inspector as product surface | `/_pome/state` digests only |
| Silent stub success for unsupported fields | Loud GraphQL errors or 501 unsupported envelope |
| Session-less opaque tokens without sid binding | Tokens table binds `sid`; root mount uses `resolveCredential` |

## Offline fidelity notes

| Surface | Official expectation | Twin behavior |
| --- | --- | --- |
| Issue archive | Soft archive with `archivedAt` | `issueArchive` / `issueUnarchive` set/clear timestamps |
| OAuth actor | user vs app | Seed `oauth_apps[].actor` authoritative |
| Webhook headers | `Linear-Delivery`, `Linear-Event`, optional `Linear-Signature` | Emitted on mutation dispatch |
| Agent sessions | Subset for local agent tests | GraphQL-only create/update/activity (not in MCP launch set) |
| Agent session status | Follows the agent's emitted activities; Linear publishes no table | Twin-owned mapping — see “Agent session status” below (F-1176) |
| MCP documents tools | Full parent set incl. initiative | Gate-1: project/team/issue/cycle parents only |
| MCP tool count | ~50+ live tools | Frozen 22-tool Gate-1 subset |

## Webhook asymmetries (documented Gate-0 gaps)

These are intentional twin divergences — not silent stubs:

| Mutation / path | Official-ish expectation | Twin behavior |
| --- | --- | --- |
| `agentSessionCreateOnIssue` | `AgentSessionEvent` create webhook | Emits webhook (`action: created`) |
| `agentSessionCreateOnComment` | Same family as on-issue create | **No webhook** — session row only (mention path stays quiet) |
| `createProject` / `updateProject` (MCP `save_project`) | Project create/update webhook | **No webhook emit** — projects mutate SQLite state only |
| `agentActivityCreate` with `content.type: prompt` | Prompted session event | Emits `AgentSessionEvent` / `prompted`, carrying the status the activity just produced |
| Issue / comment CRUD | Issue / Comment webhooks | Emitted (create/update/remove/archive) |

## Agent session status — the one invented behaviour (F-1176)

The agent-session mutation inputs are Linear's, field for field, and
[`test/linear-schema-subset.test.ts`](test/linear-schema-subset.test.ts) guards
all four against Linear's real introspection. One thing in that change could
not be read off upstream and is therefore twin-owned, named here rather than
left to be discovered.

Upstream, `AgentSessionUpdateInput` has no `status` field: Linear's agent guide
says only that session state “is updated automatically based on the agent's
emitted activities. No manual state management is required.” So the *shape* of
the model is verified upstream truth — status follows activities, and is not
settable through the update mutation — while the *table* is ours:

| activity `content.type` | resulting `AgentSession.status` |
| --- | --- |
| `thought`, `action` | `active` |
| `elicitation` | `awaitingInput` |
| `response` | `complete` |
| `error` | `error` |
| `prompt` | `pending` |

Linear never publishes which activity yields which status, and introspection
cannot show behaviour. The alternative to naming this table was a twin whose
sessions sit at `pending` forever, which is worse fidelity than a documented
mapping. It lives in exactly one place —
`AGENT_ACTIVITY_SESSION_STATUS` in [`src/domain/normalize.ts`](src/domain/normalize.ts).

### Scalar-level gaps left open on the same surface

The subset guard is name-based by F-1172's design, so these pass it. They are
open, not fixed, and closing them is separate work:

| Field | Linear | Twin |
| --- | --- | --- |
| `AgentSessionUpdateInput.plan` | `JSONObject` | `String` |
| `AgentActivity.content` (output) | `AgentActivityContent` union | `JSON!` |

`AgentActivityCreateInput.content` *is* `JSONObject!`, as upstream, and is
parsed against the six union members (`normalizeActivityContent`), so a
malformed payload is refused at the boundary rather than stored.

### Fields on these types the twin does not model

Ordinary coverage scope — a subset, not a divergence — listed so nobody
re-derives it: `externalLink`, `addedExternalUrls`, `removedExternalUrls`,
`dismissedAt` and `userState` on the session inputs; `id`, `signalMetadata` and
`contextualMetadata` on `AgentActivityCreateInput`. Linear's
`AgentSessionCreateInput` (the pull-request-scoped create, and where
`appUserId` actually lives upstream) and `AgentSessionUserStateInput` are not
declared at all.

## Other non-oracles

- Real Linear.app network sync
- Full GraphQL schema / introspection dump
- Production rate limits, inbox, initiatives, customer APIs
- Expanding MCP beyond the frozen 22-tool Gate-1 set without a new ruling
