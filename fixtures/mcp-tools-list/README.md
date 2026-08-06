# Upstream MCP `tools/list` goldens (F-1326)

What the **vendor** serves, frozen. Produced by `scripts/capture-mcp-tools-list.mjs` from the
declared source table in [`config/mcp-capture-sources.json`](../../config/mcp-capture-sources.json).
Nothing here is hand-written, and nothing here is a fact about a pome twin — these files are the
other side of the comparison F-1325's lane makes.

```bash
node scripts/capture-mcp-tools-list.mjs                 # re-capture and write
node scripts/capture-mcp-tools-list.mjs --check         # re-capture, compare, write nothing
node scripts/capture-mcp-tools-list.mjs --check --offline  # what CI runs: no network, no toolchain
node scripts/capture-mcp-tools-list.mjs --twin <id>     # one twin
```

The producer is **not** on a cron. Refresh it deliberately and read the diff: a change in these
bytes is a change in what the vendor serves. The staleness alarm over them is F-1328.

## Per twin

| twin | substrate | files | what was read |
| --- | --- | --- | --- |
| gmail | `live-wire-unauth` | `gmail.{raw,meta,canonical}.json` | unauthenticated `tools/list` against `gmailmcp.googleapis.com/mcp/v1` (HTTP 200, 13 tools) |
| github | `oss-source` | `github.{raw,meta,canonical}.json` | `github/github-mcp-server` built from a pinned commit and driven over stdio with `--toolsets=default` (44 tools) |
| stripe | `not-captured` | `stripe.status.json` | nothing — `@stripe/mcp` ships no tool table and the live surface is per-credential |
| slack | `live-wire-oauth` | `slack.status.json` | deferred to F-1329 (needs a token, not an adapter) |
| linear | `live-wire-oauth` | `linear.status.json` | deferred to F-1329 (needs a token, not an adapter) |

## The three files

- `<twin>.raw.json` — the upstream response, **verbatim**. Never reformatted; no trailing newline.
- `<twin>.meta.json` — the provenance contract: `endpoint`, `method`, `protocol`, `protocolVersion`,
  `captureDate`, `rawFileSha256`, `canonicalFileSha256`, `substrate`, `liveToolCount`,
  `liveToolOrder`, and the `configuration` the adapter assumed. Both shas are computed from the
  bytes on every run; a hand-typed one reds `--check`.
- `<twin>.canonical.json` — derived from `raw.json`: the same `result` with the provenance block
  attached and whitespace that a human can read a diff of.

`<twin>.status.json` replaces all three for a twin this producer does not capture, and records why.

## The trap the github adapter exists to avoid

`api.githubcopilot.com/mcp/` — the URL `examples/support-triage` actually declares — serves the
`default` toolset, **not** every toolset. Measured at the pinned commit: `default` is 44 tools,
`all` is 85. An adapter that read the Go source naively would take the union and report 41 coverage
gaps for tools no examinee of ours can call. F-1179: a lane reporting divergence that is not real is
worse than one honestly reporting `not-compared`.

The one place the capture is knowingly incomplete is recorded in
`github.meta.json` → `configuration.knownRemoteOnlyToolsNotInCapture`: the remote deployment adds
`create_pull_request_with_copilot` to the (default) Copilot toolset, and that tool exists in no
public source. A consumer must treat it as `not-compared`, never as a gap.

## Why stripe is `not-captured`

`@stripe/mcp@0.3.3` is a 182-line stdio↔HTTP proxy to `mcp.stripe.com`; `grep -c inputSchema dist/*.js`
is `0`. It declares no tools. Its own CLI says tool permissions "are now controlled by your Restricted
API Key", so the served listing is a function of the caller's key rather than of the deployment, and
the docs list a Treasury group behind a separate preview request. There is no deployment-invariant
table to freeze, so this producer freezes nothing rather than inventing one.
