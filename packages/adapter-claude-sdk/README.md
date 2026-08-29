<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/adapter-claude-sdk

Drop-in adapter for Anthropic's `claude-agent-sdk`. Add one import + one call,
and your agent's runs produce overlay signals (`HookEvent` audit rows plus
`ToolUseEvent` / `ToolResultEvent` payload rows) that let the
Pome correlator stitch your trace into a [`Run`](../../cli/src/contract/run.ts) with named lanes,
ordered steps, and a generated fix prompt.

## One-import API

```ts
import { withPome, tool, query } from "@pome-sh/adapter-claude-sdk";

withPome();   // installs globalThis.fetch hook + signals writer

// `tool` and `query` are drop-in replacements for the Anthropic SDK exports
// — wrap your handlers and iterate `query()` exactly the same way. One
// deliberate difference: `query()` defaults `options.settingSources` to `[]`.
// See "Isolation: sealed by default" below.
const myTool = tool(
  "list_open_issues",
  "List open issues on the GitHub twin.",
  schema,
  async ({ owner, repo }) => { /* user code; fetch() inside is tagged */ }
);

for await (const msg of query({ prompt, options })) {
  // each SDK hook fires a HookEvent audit row into the signals file
}
```

That's the whole user-facing surface.

## Isolation: sealed by default

**Since 0.4.0**, `query()` defaults `options.settingSources` to `[]` — the
SDK's own documented isolation mode — when you do not choose one. Everything
else is still forwarded verbatim.

Without it, an agent inherits the **filesystem settings of whatever machine it
runs on**: user (`~/.claude/settings.json`), project (`.claude/settings.json`)
and local (`.claude/settings.local.json`), *including the Claude Code plugin
MCP servers configured there*. The SDK loads all three when the option is
omitted, "matching CLI defaults" — sensible for the `claude` CLI, wrong for a
programmatic agent, and actively dangerous for one being graded.

Measured 2026-08-05: a `claude-haiku-4-5` trial of the `support-triage` exam,
launched from a developer shell with `tools: []` **already set**, called
`mcp__plugin_slack_slack__slack_search_channels`, `…__slack_search_public` and
`…__slack_list_channel_members`. It searched the developer's real Slack
workspace, made zero twin calls, and would have scored as *the agent failed to
triage* — a verdict about the wrong workspace entirely. Re-run with
`settingSources: []`, the same trial called only `mcp__github__*` /
`mcp__slack__*` and scored 75.

`tools` and `settingSources` are **different doors**, and shutting one says
nothing about the other:

| option | governs | adapter default |
| --- | --- | --- |
| `options.tools` | the SDK's **built-in** base set (`Bash`, `Read`, `Grep`, …) | **none** — yours to choose |
| `options.settingSources` | **filesystem settings** — user + project + local, *including plugin MCP servers* | **`[]`** |

`allowedTools` is not a substitute for either: it only auto-approves, it does
not restrict.

**Why `tools` is not defaulted.** `settingSources: []` removes configuration
the *host* supplied and you never asked for. `tools: []` would remove your
agent's own hands. Only the first is this adapter's to shut. If you want the
closed sandbox an exam wants, pass `tools: []` yourself.

**Opting out** is by naming what you want, never by omission:

```ts
// Restores the pre-0.4.0 behaviour exactly.
query({ prompt, options: { settingSources: ["user", "project", "local"] } });

// Narrower, and usually what you actually want: the SDK loads CLAUDE.md only
// when 'project' is among the sources.
query({ prompt, options: { settingSources: ["project"] } });
```

Passing `settingSources` — any value, including `[]` — always wins. An explicit
`undefined` counts as *not chosen*, matching the SDK's own `!== undefined`
branch, so the seal cannot depend on how you spelled "I didn't choose".

## What it does

| Signal | How it lands |
| --- | --- |
| `tool_call_id` header on outgoing twin requests | Wrapped `tool()` puts an id into `AsyncLocalStorage` for the lifetime of the handler. `globalThis.fetch` is replaced once at `withPome()` time; outgoing requests to **allowlisted twin origins** carry `x-pome-correlation-id: tlc_<hex>`. The twin's recorder reads the header and writes it into the event. |
| `HookEvent` audit row per SDK hook invocation | Wrapped `query()` merges a read-only hook into every entry in the SDK's `HOOK_EVENTS` (PreToolUse / PostToolUse / SubagentStart / PreCompact / PermissionRequest / TaskCreated / SessionStart / …). Each invocation appends one row matching [`hookEventSchema`][wire] — `{ts, event_id, parent_id, kind:"HookEvent", hook_name, tool_name}` — to a JSONL sidechannel file (`process.env.POME_ADAPTER_SIGNALS_PATH`). User-supplied hooks in `options.hooks` are preserved. |

## When it's a no-op

- **No `POME_ADAPTER_SIGNALS_PATH`** → no signals file written. The fetch hook
  still installs; the header still flows on allowlisted hosts. This is the
  standalone-dev mode: run your agent without the Pome CLI and nothing crashes.
- **No allowlisted twin hosts** → no header injection (the fetch hook is a
  transparent passthrough). `withPome()` infers the allowlist from
  `POME_TWIN_BASE_URL`, `POME_GITHUB_MCP_URL`, and any
  `POME_*_BASE_URL` / `POME_*_MCP_URL` env var the CLI runner injected. Pass
  `withPome({ twinHosts: ["http://localhost:3333"] })` to override.
- **`fetch()` outside any wrapped tool handler** → no header (the
  `AsyncLocalStorage` scope is empty, so Anthropic API calls from inside
  `claude-agent-sdk` are naturally immune).

## Architecture

`tool_call_id` lands on the twin's `TwinHttpEvent` at the moment the request
reaches the twin — single source of truth, no race under parallel tool calls.
`HookEvent` rows are written to the sidechannel as each SDK hook fires; they
follow the discriminated-union schema in
[`packages/wire/src/recorder-events.ts`][wire], so the
correlator can merge them into `events.jsonl` by `ts`-ordered
insertion. Hook handlers are read-only — they observe and never mutate the
event the SDK passes them.

Rationale for choosing global `fetch` replacement (with ALS gating + host
allowlist) over a `pomeFetch` helper, sidechannel-only correlation, or
side-effect import is not restated here.

### Where the correlation core lives

The correlation mechanism itself is **not in this package**. The
`AsyncLocalStorage` store, the `x-pome-correlation-id` fetch injection, and the
fallback id minter are framework-agnostic and live in
[`@pome-sh/wire/correlation`](../wire/README.md#pome-shwirecorrelation), so a
Vercel AI SDK or LangGraph adapter gets the same race-proof guarantee without
re-deriving it. Wire is inlined into this package's bundle, so the published
tarball still has no `@pome-sh/*` runtime dependency.

What is Claude-specific, and stays here: reading the SDK's real `tool_use_id` off
the MCP `_meta["claudecode/toolUseId"]` key (`src/wrapHandler.ts`), the `tool()`
and `query()` wrappers, and `withPome()`'s `POME_*` env-var host inference. The
split boundary is one line per framework — where the tool-call id comes from and
where the scope opens.

## Caveats

- **HTTP layer is `globalThis.fetch` only.** Node 18+ `undici`, browser fetch,
  most modern HTTP libs route through `fetch` by default. `axios`, `got`, or
  the raw `node:http` module **don't** — wrap your client manually if you use
  one of those, or pin your code to `fetch`.
- **v0 returns an `AsyncGenerator` from `query()`**, not the full `Query`
  interface. Control methods like `interrupt()` or `setPermissionMode()` are
  not re-exposed yet — call `claude-agent-sdk`'s `query` directly if you need
  them. Iteration is what hero tasks use today.
- **`withPome()` is idempotent.** A second call is a no-op; the global fetch
  replacement is installed exactly once per process.
- **`query()` turns on `includePartialMessages` when telemetry is on**, because
  a turn's finished output-token count reaches the SDK only on a `message_delta`
  stream event — the `assistant` message carries a `message_start` snapshot
  roughly 5x too low. Every message that option adds is filtered back out before
  it reaches your iterator, so your `for await` loop sees exactly what it saw
  before; a test asserts the yielded sequence is identical with telemetry on and
  off. Set the option to `true` yourself and nothing is filtered. Measured cost:
  ~1.3–1.4x the stream bytes. `POME_DISABLE_PARTIAL_MESSAGES=1` opts out, at the
  price of the low number.
- **Sub-agent turns still report the snapshot.** The SDK forwards no stream
  events for Task sub-agents (measured: 34 stream events on a two-sub-agent run,
  none of them tagged with a `parent_tool_use_id`), so there is no
  `message_delta` to read and those turns keep the low count. They are a small
  share of a run's output. Note also that `SDKResultMessage.usage` counts only
  the main agent, while both lanes emit a row per turn either way — so on a run
  that uses sub-agents the lanes total *more* than the SDK's own rollup rather
  than matching it exactly.

## Signals file format

One JSON object per line, ordered by emission time. Rows follow the M0
discriminated-union shape in [`wire`][wire]:

```jsonl
{"ts":"2026-05-26T20:00:00.000Z","event_id":"...","parent_id":null,"kind":"HookEvent","hook_name":"SessionStart","tool_name":null}
{"ts":"2026-05-26T20:00:00.123Z","event_id":"...","parent_id":"toolu_abc","kind":"HookEvent","hook_name":"PreToolUse","tool_name":"list_open_issues"}
{"ts":"2026-05-26T20:00:01.456Z","event_id":"...","parent_id":"toolu_abc","kind":"HookEvent","hook_name":"PostToolUse","tool_name":"list_open_issues"}
```

The correlator reads this alongside `events.jsonl` and produces a
`Run` with named lanes + ordered steps.

## License

Apache-2.0.

[wire]: ../wire/src/recorder-events.ts
