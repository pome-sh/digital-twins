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
| Agent session status | Follows emitted activities; mapping unpublished | Twin-owned transition table — see below |
| `AgentActivityCreateInput.content` | `JSONObject!` validated against the `AgentActivityContent` union | Same field, validated member-for-member; `bodyData` / `resultData` unmodelled |
| MCP documents tools | Full parent set incl. initiative | Gate-1: project/team/issue/cycle parents only |
| MCP tool count | ~50+ live tools | Frozen 22-tool Gate-1 subset |

## Agent-session status transitions (twin-owned, F-1176)

Linear declares no `status` on `AgentSessionUpdateInput`. Status follows the
activity the agent emits — Linear's agent guide says session state is "updated
automatically based on the agent's emitted activities. No manual state management
is required." That much is upstream truth and the twin implements it.

Which activity yields which status is **not published**, and introspection cannot
show behaviour. The twin owns this table:

| activity content type | resulting session status |
| --- | --- |
| `thought`, `action` | `active` |
| `elicitation` | `awaitingInput` |
| `response` | `complete` |
| `error` | `error` |
| `prompt` | `pending` |

Do not treat it as verified upstream behaviour. Replace it with the real mapping
if Linear ever documents one. The alternative — refusing to derive status at all —
leaves every twin session frozen at `pending`, which is worse fidelity than a
named guess.

## Scalar-level divergences on the guarded agent types

The subset guard in `test/linear-schema-subset.test.ts` compares member NAMES, so
these two pass it and are recorded here instead:

| surface | Linear | twin | why |
| --- | --- | --- | --- |
| `AgentSessionUpdateInput.plan` | `JSONObject` | `String` | The twin stores a plan as opaque text; nothing reads into it |
| `AgentActivity.content` | `AgentActivityContent` union | `JSON!` | The twin validates the union on input but does not model six output types to serve it |

## Webhook asymmetries (documented Gate-0 gaps)

These are intentional twin divergences — not silent stubs:

| Mutation / path | Official-ish expectation | Twin behavior |
| --- | --- | --- |
| `agentSessionCreateOnIssue` | `AgentSessionEvent` create webhook | Emits webhook (`action: created`) |
| `agentSessionCreateOnComment` | Same family as on-issue create | **No webhook** — session row only (mention path stays quiet) |
| `createProject` / `updateProject` (MCP `save_project`) | Project create/update webhook | **No webhook emit** — projects mutate SQLite state only |
| `agentActivityCreate` with `content: {type: prompt}` | Prompted session event | Emits `AgentSessionEvent` / `prompted` |
| Issue / comment CRUD | Issue / Comment webhooks | Emitted (create/update/remove/archive) |

## Other non-oracles

- Real Linear.app network sync
- Full GraphQL schema / introspection dump
- Production rate limits, inbox, initiatives, customer APIs
- Expanding MCP beyond the frozen 22-tool Gate-1 set without a new ruling
