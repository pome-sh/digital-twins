# Linear twin fidelity

Heat × fidelity per [`ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). Machine-readable twin: [`fidelity.inventory.json`](fidelity.inventory.json).

## MCP launch tools (22)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `list_issues` | hot | semantic | `TC:issue-triage`; `MCP:list_issues` |
| `get_issue` | hot | semantic | `TC:issue-triage`; `MCP:get_issue` |
| `save_issue` | hot | semantic | `TC:issue-create\|issue-triage`; estimate/parentId/relations |
| `list_comments` | hot | semantic | `TC:comment`; `MCP:list_comments` |
| `save_comment` | hot | semantic | `TC:comment`; threaded `parentId` |
| `delete_comment` | warm | semantic | Gate-1; GraphQL `commentDelete` parity |
| `list_teams` | hot | semantic | `TC:issue-create`; `MCP:list_teams` |
| `get_team` | warm | shape | `MCP:get_team` |
| `list_users` | hot | semantic | `TC:issue-create`; `MCP:list_users` |
| `get_user` | warm | shape | `MCP:get_user` |
| `list_issue_statuses` | hot | semantic | `TC:issue-triage`; `MCP:list_issue_statuses` |
| `get_issue_status` | warm | shape | `MCP:get_issue_status` |
| `list_issue_labels` | hot | semantic | `TC:issue-triage`; `MCP:list_issue_labels` |
| `create_issue_label` | warm | shape | `MCP:create_issue_label` |
| `list_projects` | warm | semantic | SQLite project CRUD + issue linkage |
| `get_project` | warm | semantic | SQLite project CRUD + issue linkage |
| `save_project` | warm | semantic | SQLite project create/update |
| `list_cycles` | warm | semantic | SQLite cycle list + issue linkage |
| `search_documentation` | cold | shape | `MCP:search_documentation` — static/empty twin docs |
| `list_documents` | warm | semantic | Gate-1 workspace documents (SQLite) |
| `get_document` | warm | semantic | Gate-1 workspace documents (SQLite) |
| `save_document` | warm | semantic | Gate-1 create/update with one parent |

## GraphQL (selected)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `issues` / `issue` / issue mutations | hot | semantic | `TC:issue-triage\|issue-create`; estimate/parent |
| `comments` / comment mutations | hot | semantic | `TC:comment`; threaded parent; `commentDelete` |
| `teams` / `users` / `workflowStates` | hot | semantic | Context for agent chains |
| `issueLabels` / label mutations | hot | semantic | Triage labels |
| `projects` / `cycles` | warm | semantic | PM context backed by SQLite domain |
| `webhooks` / webhook mutations | hot | semantic | `TC:webhook-integrate` |
| agent session / activity mutations | warm | semantic | Emulate agent subset; MCP-absent |
| OAuth authorize/token/revoke | hot | semantic | `TC:oauth-app` |

## Named cold / unsupported

| Surface | Heat | Fidelity | Notes |
| --- | --- | --- | --- |
| Initiatives / milestones / releases MCP | cold | unsupported | Outside Gate-1 tool set |
| Full Linear schema tail | cold | unsupported | Loud GraphQL / 501 |
| Document parents: initiative | cold | unsupported | Twin accepts project/team/issue/cycle only |

## Opt-in OAuth scope denial

`seed.strictScopes` defaults to `false`. Enable it for tasks that mint
restricted tokens and expect Linear-like scope errors. With the flag on, GraphQL
and MCP writes share `LinearDomain.requireScopes`. JWT / provider sessions are
granted the full default scope set so common agent paths stay unblocked.

## Tier-mismatch ledger

_(empty at launch)_

## Declared input surface (F-1179)

Fidelity is not only about what a surface *answers*; it is also about what it
*accepts*. An agent can call this twin with a parameter the real vendor rejects,
or omit one the vendor requires, and the response shape can be identical either
way — so the output comparison cannot see it. That is the same class of gap as
F-1166, which was only caught because a write round-trip happened to read back a
field nobody had mentioned.

So each route declares its inputs, and **the declaration is the thing the handler
validates against** — not a description of it. `declareRouteInputs()`
([`packages/sdk/src/route-inputs.ts`](../sdk/src/route-inputs.ts)) returns one
object carrying both the machine-readable surface and the `parse()` a handler
receives its values from. A handler is handed no request object to read around
the declaration with, and
[`scripts/lint-route-input-declarations.mjs`](../../scripts/lint-route-input-declarations.mjs)
fails the build if any module a route registrar reaches reads one imperatively.

**This twin declares 120 inputs across 45 published surfaces**
(86 argument, 11 query, 22 body, 1 header), 31 of them required. Each carries its name, location,
requiredness and best-effort type, all *derived from the schemas that validate* —
requiredness by asking the validator whether the input may be absent, and type by
way of JSON Schema. Nothing here is hand-written, so nothing here can drift from
the handler.

twin-linear was already the model for the other four: it serves every `/graphql` request
against `linearGraphQLSchema`, so its 39 argument-bearing root fields were readable with zero
transcription. Nothing about that changed. What F-1179 added is publication through the same
seam as the other twins — `route-inputs.json` carries both halves, the GraphQL arguments under
`graphql_surfaces` (keyed `GQL <rootField>`, `location: "argument"`, SDL type spelling) and
the HTTP TRANSPORT under `surfaces`.

The transport half was as undeclared as any of the four HTTP twins: the GraphQL envelope
(`query` / `variables` / `operationName`) and the four OAuth endpoints, which are ordinary
form-posted surfaces with nothing GraphQL about them. Those are declared now. Operation input
SHAPES are out of scope here and remain F-1176's.

The published artifact is
[`route-inputs.json`](route-inputs.json), regenerated by
`npm run emit:route-inputs` and byte-compared in CI by
`npm run gate:route-inputs`. It is read by pome-cloud's declared-fidelity lane
through the checkout seam it already has, which is what turns 1,130
vendor-declared inputs on matched surfaces from `not-compared` into a real
two-way comparison — and makes `missingRequired` live. Surfaces with no declared
inputs are omitted rather than published with an empty list: comparing nothing
against nothing would render as a match nobody measured.


### Undeclared inputs: `ignore` (F-1372)

**Linear ignores a request parameter it does not recognise, so this twin
discards them too.** Four of this twin's six HTTP routes are OAuth, where it is
not Linear's choice to make: RFC 6749 says *"The authorization server MUST
ignore unrecognized request parameters"* in **§3.1** for the authorization
endpoint and again in **§3.2** for the token endpoint, and `/oauth/revoke`
follows the token endpoint's conventions (RFC 7009).

Measured 2026-08-09 against real Linear:

- `GET /oauth/authorize` served its consent page identically with and without
  an unknown parameter — 24,446 bytes either way, differing only in a
  per-request CSP nonce.
- `POST /oauth/token` answered the same `invalid_client` both ways.
- `POST /graphql` answered identically for an unknown top-level envelope key
  and for an unknown query-string key.

The transcript, including the one case this does **not** cover — `extensions`,
a GraphQL-over-HTTP envelope member this twin declares nowhere and Linear
rejects for its own reasons — is in
[`docs/undeclared-route-inputs.md`](../../docs/undeclared-route-inputs.md).
