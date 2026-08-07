# Which lane calls which declared endpoint (F-1305)

The delta F-1305 asks for first, written down. Measured on `11f1db2`, not
recalled: every number below came from booting the twins and counting what was
called, and the method is reproducible from this file.

## What "a declared endpoint" is

Prod `list_twins` advertises **111 endpoints** — github 65, slack 11, gmail 13,
linear 22. Those four numbers are each twin's **MCP tool count**, identical to
the `tools` array in its `fidelity.inventory.json` and to what its own
`tools/list` answers. `list_twins` does not advertise stripe, whose 26 tools
bring the real declared surface to **137**.

An endpoint in this sense is an MCP tool, not a REST route. The REST/GraphQL
surfaces are larger and separately inventoried (github 62 REST, stripe 43,
slack 50, gmail 54, linear 45 GraphQL operations) and are not what the 111
counts. Where a REST route performs the same action as a tool, the recorder
stamps the same `tool` name on both — but only for `TAPE_ASSERTABLE_TOOLS`, the
two actions a tape check names (`packages/twin-github/src/routes.ts`,
`handleAs`). Every other REST row records `tool: null` by design, so REST
traffic cannot be counted toward tool coverage.

## The measurement

Two runs, one hook. A temporary line in `createRecorderHandle`'s `accept()`
(`packages/sdk/src/recorder.ts`) appended `twin, tool, method, path, status`
for every recorded event — one choke point that covers `handle()`-wrapped REST
routes, the JSON-RPC tool dispatch, the failure injector, and stripe's own
recorder. Then:

1. every twin's vitest suite, one file per twin;
2. `npm run probe:examples` — the F-1152 example gate, all 43 probes.

Coverage is "the twin recorded an event stamped with this tool name", which is
true of an MCP `tools/call` and of the REST routes that stamp. A domain-level
`executeTool()` call in a unit test is NOT coverage here, and that distinction
is the finding.

## The result

| twin | declared | reached over the MCP wire by its own suite | reached by the 43 example probes | **reached by nothing** |
| --- | --- | --- | --- | --- |
| github | 65 | 65 | 9 | 0 |
| stripe | 26 | 26 | 0 | 0 |
| slack | 11 | **3** | 0 | **8** |
| gmail | 13 | 13 | 0 | 0 |
| linear | 22 | **7** | 0 | **15** |
| **total** | **137** | **114** | **9** | **23** |

Every one of the 114 was answered 2xx at least once, so none of them is a tool
that is only ever exercised on its error path.

**The 23 nothing called**

- slack: `slack_reply_to_thread`, `slack_add_reaction`,
  `slack_get_channel_history`, `slack_get_thread_replies`, `slack_get_users`,
  `slack_search_messages`, `slack_get_reactions`, `slack_list_channel_members`
- linear: `list_comments`, `list_teams`, `get_team`, `list_users`, `get_user`,
  `list_issue_statuses`, `get_issue_status`, `list_issue_labels`,
  `create_issue_label`, `list_projects`, `get_project`, `save_project`,
  `list_cycles`, `search_documentation`, `list_documents`

All 23 are inside prod's advertised 111.

They are not untested — slack's `test/tools-execute.test.ts` is titled "runs all
11 tools" and does. It calls `executeTool(domain, name, args)` **directly on the
domain object**, never over HTTP, so the MCP dispatch layer for those eight
tools has never run. That is exactly the layer `comment_on_pull_request` was
broken at: the GitHub domain's comment code was fine, and the call still
answered `404 Issue not found` for the entire life of two examples. A
domain-level test is the shape of test that was green through the incident this
whole lane exists because of.

## What each existing lane actually covers

| lane | subject | live call? | reach over the 137 |
| --- | --- | --- | --- |
| `packages/twin-*/test/**` (vitest) | the twin's behaviour | in-process HTTP, and domain calls that bypass it | 114 over the wire; the other 23 at domain level only |
| `scripts/probe-example-tools.mjs` (F-1152) | **a bundled example's** tool table | yes | 9, all github |
| `apps/control-plane/scripts/post-deploy-twin-smoke.ts` (pome-cloud) | a deployed session boots and serves | yes, against prod | ~10 REST routes; adds 0 tool names |
| `packages/twin-*/test/checks-predicates.test.ts` | a declared `[code]` check answers its own sentence | no — hand-built state fixtures | 0 |
| `declared-diff.json` (status page, C3) | our declared SHAPE vs upstream's | no — spec comparison | 0 by construction |
| F-1293 | our declared tool LIST vs upstream's | no — set comparison | 0 by construction |

The 43-probe figure overstates twin coverage badly, and the reason is
structural rather than anyone's fault: the 43 are *example* tools, and one
example tool is usually a wrapper that makes one REST call. Those 43 probes
produce 34 recorded twin calls, of which 25 are REST rows carrying no tool name
at all. Nine name a github tool. Zero touch stripe, and no bundled example
declares the stripe twin.

## Boundaries settled

- **vs F-1293 (MCP tool surface vs upstream)** — F-1293 asks *is our LIST the
  right list*: does the set of tools we declare match what upstream declares.
  F-1305 asks *does each thing on our list ANSWER when called*. A twin can pass
  either and fail the other: a perfectly-matching list of tools that all 404,
  or 137 tools that all work and three of which upstream deleted last quarter.
  Neither gate subsumes the other and neither needs to know about the other.
- **vs C3 (`declared-diff`, the upstream comparison has no blind spots)** — the
  same split one level up. `declared-diff` compares declarations against
  upstream goldens and makes no call, so it cannot close a "nothing calls it"
  gap for the same reason `typecheck:examples` could not: it is green on a
  well-typed declaration whose endpoint 404s.
- **vs the F-1152 example gate** — different subjects, and **neither replaces
  the other**. The example gate asks *does this example's wrapper work*; the new
  gate asks *does this twin's declared endpoint answer*. `comment_on_pull_request`
  was findable from both sides (the example passed a PR number; the twin refused
  it) which is why the regression now lives in both suites. An example gate red
  points at `examples/`; a twin gate red points at `packages/twin-*/`. Deleting
  either loses a direction. The example manifest's 43 entries stay, and are
  already generated in the sense the ticket asks for — the SET comes from the
  example's own registered tool table at runtime and a registered tool with no
  fixture arguments is the `unprobed-tool` red.

## What closed, and what did not

`npm run probe:twins` (`scripts/probe-twin-endpoints.mjs`) takes the endpoint
list from each twin's own `tools/list` and calls all 137, on each twin's own
default seed, in-process, in ~0.4s with no model, no API key and no socket. The
23 are covered; stripe is covered; a twin that gains a tool gains a probe with
no hand edit to any list, and a declared tool with no fixture arguments is a red
naming the twin and the endpoint.

Still open, and tracked on the ticket rather than here:

- **The chain lane.** A zero-model prober cannot reach a `substrate: tape`
  criterion, and 22 of the 24 unmeasured `[code]` criteria in the corpus are
  tape criteria. One end-to-end chain task per twin is the only lane that
  crosses all six seams; it needs real model runs and is not part of this gate.
- **Check coverage.** `defineCheck` declares grading predicates, not endpoints.
  Whether each declared check can be made both to pass and to fail against a
  live twin is a separate, smaller question this gate does not answer.

## Reproducing

The measurement hook was temporary and is not in the tree. To redo it, add to
`accept()` in `packages/sdk/src/recorder.ts`:

```js
const covPath = process.env.POME_F1305_COVERAGE_PATH;
if (covPath) {
  appendFileSync(covPath, `${event.twin}\t${event.tool ?? ""}\t${event.method}\t${event.path}\t${event.status}\n`);
}
```

then `npm run build -w @pome-sh/sdk` (the twins import the SDK through its
`dist/`, so editing `src/` alone records nothing) and run each suite with
`POME_F1305_COVERAGE_PATH` set. Diff the distinct tool names against the
twin's tool-table fixture (`githubToolFixture.toolNames` and its siblings, or
`packages/twin-*/fixtures/mcp-tools-list.raw.json` straight off disk — F-1325
retired the per-twin `listTools()` helpers). Revert the hook afterwards.
