# Upstream MCP `tools/list` goldens (F-1326)

What the **vendor** serves, frozen. Produced by `scripts/capture-mcp-tools-list.mjs` from the
declared source table in [`config/mcp-capture-sources.json`](../../config/mcp-capture-sources.json).
Nothing here is hand-written, and nothing here is a fact about a pome twin — these files are the
other side of the comparison F-1325's lane makes.

```bash
node scripts/capture-mcp-tools-list.mjs                 # re-capture and write
node scripts/capture-mcp-tools-list.mjs --check         # re-capture, compare, write nothing
node scripts/capture-mcp-tools-list.mjs --check --offline  # what CI runs: no network, no toolchain
node scripts/capture-mcp-tools-list.mjs --offline       # re-derive from the committed raw.json and write
node scripts/capture-mcp-tools-list.mjs --twin <id>     # one twin
```

The producer is **not** on a cron. Refresh it deliberately and read the diff: a change in these
bytes is a change in what the vendor serves. The staleness alarm over them is F-1328.

`--offline` without `--check` is the one mode that writes without reading a vendor, and it exists
for `configuration` (F-1394). That block is prose ABOUT a capture and is copied verbatim into
`meta.json` and `canonical.json`, so a sentence added to the source table moves two golden files —
and three of the five sources are behind one-shot OAuth grants that are minted, used once and
revoked. Without this mode, correcting a sentence about slack's golden would mean minting a fresh
Slack grant, so in practice it would mean editing the goldens by hand, which is what `--check`
exists to catch. It cannot forge a capture: `raw.json` is its input, so every derived field still
comes from the bytes the vendor sent, and `captureDate` is carried from the committed `meta.json`
rather than stamped, so a re-derivation can never make an old reading look like a fresh one.

## Per twin

All five are captured; the two `status.json` files F-1326 wrote for slack and linear were retired
by [F-1329](https://linear.app/pome-sh/issue/F-1329)'s captures, and stripe's by the same errand.

| twin | substrate | completeness | what was read |
| --- | --- | --- | --- |
| gmail | `live-wire-unauth` | `exact` | unauthenticated `tools/list` against `gmailmcp.googleapis.com/mcp/v1` (HTTP 200, 13 tools) |
| github | `oss-source` | `subset-of-remote` | `github/github-mcp-server` built from a pinned commit and driven over stdio with `--toolsets=default` (44 tools) |
| stripe | `live-wire-oauth` | `credential-scoped` | `mcp.stripe.com` under an OAuth grant on the Pome account in test mode, all permissions = Write (11 tools) |
| slack | `live-wire-oauth` | `exact` | `mcp.slack.com/mcp` under a user token carrying all 30 advertised scopes (19 tools, the count Slack documents) |
| linear | `live-wire-oauth` | `exact` | `mcp.linear.app/mcp` under a `read write` grant (58 tools) — see below |

Every file is `<twin>.{raw,meta,canonical}.json`.

### `completeness` is a claim, and criterion 9 spends it

The class names the relation between what the capture READ and what an examinee's own client
REACHES, and it is required at load rather than defaulted. pome-cloud's promotion gate refuses a
twin for serving a tool the golden does not declare (`mcp-tool-twin-only`), and that inference is
sound against `exact`; against `subset-of-remote` only where the delta is *enumerated* with
evidence, which is what github's `knownRemoteOnlyToolsNotInCapture` is; against `credential-scoped`
not at all.

### linear: the scope set is not invariant, and here is the number

[F-1329](https://linear.app/pome-sh/issue/F-1329) captured this golden under a grant limited to
`read`, so it held 36 tools and not one write. The gate then named six write tools twin-linear
serves — `save_issue`, `save_comment`, `delete_comment`, `create_issue_label`, `save_project`,
`save_document` — as tools the twin had invented, when `mcp.linear.app` serves all six.
[F-1394](https://linear.app/pome-sh/issue/F-1394) re-captured it and settled the invariance question
by measurement rather than argument. Same endpoint, same day:

| grant | tools |
| --- | --- |
| `read` | 36 |
| `read write` | 58 |

The 22 the write scope adds are every write Linear has and nothing else — the `save_*`,
`create_*`, `delete_*` set plus `merge_diff`, `resolve_diff_thread` and `submit_diff_review`.
**Nothing was removed**: the read listing is a strict subset, so a narrower grant can only ever
under-report, and a later capture of this twin may never be read-only. The scope set was never a
permission question; it decided what the listing CONTAINED.

## gmail: there is a second tools/list in this repo, and it is stale

[`packages/twin-gmail/fixtures/mcp-tools-list.*`](../../packages/twin-gmail/fixtures/) is **not**
this. It is the twin's own frozen Gate-1 launch oracle (captureDate 2026-07-20), imported by
`twin-gmail/src/mcp.ts` and asserted by that package's suite. It is authoritative for *which tools
the twin implements*. `gmail.*` here is authoritative for *what Google currently serves*, and only
this one gets re-captured.

Known delta, measured 2026-08-06: same 13 names in the same order, but **10 of the 13 differ** in
`description` and/or `inputSchema` (`search_threads` schema 3849→4274 chars, `create_label`
2813→3195, `list_labels` description 393→293). Nothing in CI relates the two files, so when F-1325's
lane reports schema divergence on gmail, check the oracle's date before concluding the twin drifted.

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
