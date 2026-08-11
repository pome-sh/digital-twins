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

**This twin declares 122 inputs across 45 published surfaces**
(86 argument, 12 query, 23 body, 1 header), 32 of them required. Each carries its name, location,
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
(`query` / `variables` / `operationName` / `extensions`) and the four OAuth endpoints, which are
ordinary form-posted surfaces with nothing GraphQL about them. Those are declared now. Operation
input SHAPES are out of scope here and remain F-1176's.

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

The transcript is in
[`docs/undeclared-route-inputs.md`](../../docs/undeclared-route-inputs.md). The
one case the ruling does **not** govern — `extensions` — is below.

### `extensions`: declared and answered, not ignored (F-1385)

**Linear runs Apollo's automatic persisted queries in verify-only mode, and this
twin mirrors the contract it was measured to have.** `extensions` is the fourth
member of the GraphQL-over-HTTP request envelope, and it is the one member the
disposition above does not reach: an unknown envelope key (`bogusKey`) leaves
Linear's answer exactly where the bare request's was, which is `ignore` working,
while `extensions` is *parsed*, and each way of getting it wrong earns its own
worded answer. An input with its own observable contract belongs in the
declaration where the comparison lane can see it; an input governed by a generic
disposition does not. So `extensions` is declared on **both** `/graphql`
surfaces, and [`src/graphql/persisted-query.ts`](src/graphql/persisted-query.ts)
answers it.

Measured 2026-08-11, with no credentials — every case is answered **before
authentication**, and the twin answers them at the same point, on a router
mounted ahead of the engine's `bearerAuth`:

| Request | Twin, and Linear |
| --- | --- |
| `extensions` absent, or carrying no `persistedQuery` | served |
| `persistedQuery` with `sha256Hash` = SHA-256 of `query` | served |
| `persistedQuery` with a hash that does not match (or the right hash in the wrong case), a `version` other than 1, or no hash at all | 400 `INTERNAL_SERVER_ERROR` |
| `persistedQuery` with no `query` to verify | 200 `PersistedQueryNotFound` |
| `extensions` that is not a usable object | 400 `BAD_REQUEST`, worded per surface |

The full table, both surfaces, is in
[`docs/undeclared-route-inputs.md`](../../docs/undeclared-route-inputs.md), and
`test/route-input-declarations.test.ts` drives every row over the real HTTP
wire — including the ordering, with a deliberately-bad token, because a
rejection that moved behind the auth check would put the divergence back in a
harder-to-see form.

**Recorded as OBSERVED, not endorsed.** `INTERNAL_SERVER_ERROR` with
`userError: false`, for what is plainly a client mistake, does not read like a
designed contract — Apollo's own vocabulary has `PERSISTED_QUERY_ID_INVALID` for
it. The twin mirrors what was measured because an agent meets the measurement,
not the intent. A re-measure that answers something else is a signal to
re-decide, not drift to suppress.

**Two things this does not model**, both pre-existing and on a different axis:
the twin registers no persisted query (neither does Linear — a hash-only request
misses even straight after the same hash arrived with its query), and the twin
implements none of Apollo's CSRF prevention, which answers 400 to a bare
`GET /graphql` at Linear unless the request carries `x-apollo-operation-name` or
`apollo-require-preflight`.
