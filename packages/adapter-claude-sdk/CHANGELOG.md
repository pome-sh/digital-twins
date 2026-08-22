# @pome-sh/adapter-claude-sdk — CHANGELOG

## 0.3.8 — 2026-08-22

**No consumer-visible change.** The nine per-workspace `vitest.config.ts` files
were replaced by one root config declaring every workspace as a vitest project,
and the per-workspace `"test": "vitest run"` scripts were removed in favour of a
single root `test`. Test selection is byte-identical -- 3,748 cases before and
after, same names. Nothing about this package's source, exports, or shipped
artifact moved. Listed only because a manifest changed, which the next release
of this package carries.

## 0.3.7 — 2026-08-21

**No code change.** Carries `packages/wire/README.md`'s removal of a link to a
`RELEASING.md` that no longer exists.

## 0.3.6 — 2026-08-13

`query()` now prints the literal `POME_SMOKE_REACHED_OUTBOUND` to stderr
immediately before its first outbound model call, and only when
`POME_SMOKE_MARK_OUTBOUND=1`. Nothing is printed in a normal run, so a consumer
who does not set that variable sees no change in output.

The marker exists so `smoke:examples` can classify on evidence the process
emitted rather than on the text of whichever error it happened to surface. The
Claude Agent SDK races on `lastErrorResultText` and produces one of two
unrelated error strings for the same underlying failure, so any classifier
reading that text is a coin flip (F-1519).

## 0.3.5

Republished for `@pome-sh/wire` 0.2.3. No source change in this package: it
depends on `wire` as a workspace `*`, so a wire release changes the bytes this
package ships and `check-version-bump-required.mjs` requires the bump. The new
`@pome-sh/wire/run-completeness` subpath is additive and this adapter does not
consume it.

## 0.3.4 — 2026-08-12

No user-visible change. Version-only bump: F-1488 fixed
`packages/wire/scripts/emit-trace-contract.mjs`'s entry guard (realpath both
sides of the `process.argv[1]` vs. `import.meta.url` compare) —
publish-relevant for this package under the `packages/wire/` prefix, because
tsup inlines wire's compiled output into the bundle. The changed file is dev
tooling that ships in no tarball; wire's published source is unchanged, so
this tarball is byte-identical in content.

## 0.3.3 — 2026-08-06

No user-visible change. Version-only bump: F-949 made `@pome-sh/wire` an
independently published artifact on GitHub Packages for cross-repo consumers,
which touched `packages/wire/package.json` — publish-relevant for this package,
because tsup inlines wire's compiled output into the bundle and its
`dist/index.d.ts`. Only wire's packaging metadata changed, no wire source, so
this tarball is byte-identical in content.

One clarification to 0.3.2's note below: it says a bare re-export of
`@pome-sh/wire/correlation` in the shipped `dist/index.d.ts` "resolves nowhere
for a consumer, since wire is never published." Wire *is* now published — to
GitHub Packages, which requires a GitHub token even to read — so that specifier
still resolves nowhere for an end user, and the local `src/correlation.ts`
re-export is still required. The conclusion is unchanged; only the reason is.
Do not turn wire into a real dependency of this package on the strength of it
being published: an end user's `npm i` would 401.

## 0.3.2 — 2026-08-06

Internal restructure — no API, behaviour or type change for consumers.
`CORRELATION_HEADER` is still exported and still `"x-pome-correlation-id"`, and
`tool()` / `query()` / `withPome()` are untouched.

The correlation core moved OUT of this package and into
[`@pome-sh/wire/correlation`](../wire/README.md#pome-shwirecorrelation) (F-950):
the `AsyncLocalStorage` store that makes per-tool-call correlation race-proof
(`src/als.ts`), the `globalThis.fetch` patch that stamps
`x-pome-correlation-id` on requests to allowlisted twin origins (`src/fetch.ts`),
and the fallback id minter (`src/ids.ts`). None of that ever knew what a Claude
tool was, and a Vercel AI SDK or LangGraph adapter needs exactly the same
guarantee — so it now lives in the shared trace package instead of behind a
Claude-shaped door. Wire is `private: true` and inlined into this package's
bundle, so the published tarball is unchanged in shape: still no `@pome-sh/*`
runtime dependency.

What remains here is the Claude-specific half, and it is small: reading the SDK's
real `tool_use_id` off the MCP `_meta["claudecode/toolUseId"]` key
(`src/wrapHandler.ts`), the `tool()` / `query()` wrappers, and `withPome()`'s
`POME_*` env-var host inference. No Vercel AI SDK or LangGraph integration is
built by this change — it is preparation, so a future one does not re-derive the
plumbing.

One packaging fix rides along: `CORRELATION_HEADER` is re-exported through a
local `src/correlation.ts` rather than straight from wire on the barrel, because
tsup's `noExternal` covers the JS bundle only. A bare re-export leaves a literal
`from '@pome-sh/wire/correlation'` in the shipped `dist/index.d.ts` — a specifier
that resolves nowhere for a consumer, since wire is never published — and the JS
keeps working, so the break lands on the consumer's `tsc` and nowhere else.
`npm run test:pack` compiles a real consumer against the shipped declarations
without `skipLibCheck`, which is what caught it.

## 0.3.1 — 2026-08-04

Packaging only — no API or behavior change. The adapter is built with tsup and
bundles its internal wire-types dependency (`@pome-sh/shared-types`, now a
`private: true` workspace package) instead of declaring it. The published
tarball therefore has no `@pome-sh/*` dependency at all: 27.6 kB unpacked, four
files. OpenTelemetry stays external (a consumer's own OTel SDK must be the same
`@opentelemetry/api` instance, or spans stop nesting) and
`@anthropic-ai/claude-agent-sdk` stays a required peer.

The adapter versions INDEPENDENTLY of `@pome-sh/cli` and is published by
`.github/workflows/release.yml` only when its own version differs from the
registry.

## 0.3.1 — 2026-08-04

Dependency patch (#302), and the one in this batch a consumer can actually observe.

- `@opentelemetry/exporter-trace-otlp-http` `^0.220.0` → `^0.221.0`. A 0.x caret
  does not cross minor, so `^0.220.0` resolves `<0.221.0` — a consumer on 0.3.0
  could not get 0.221.x at all. The other range moves in this batch are floors
  their old ranges already admitted; this one is not.
- `@opentelemetry/api` `^1.9.0` → `^1.9.1`, `@opentelemetry/sdk-trace-base`
  `^2.0.0` → `^2.10.0` (already admitted).
- Repinned to `@pome-sh/shared-types@0.14.1`.
- Peer range on `@anthropic-ai/claude-agent-sdk` is unchanged at `^0.3.215`.

## 0.3.0 — 2026-08-04

The correlation header carries the SDK's real `tool_use_id` (F-1200).

- `wrapHandler` reads it from the MCP handler's `extra` argument
  (`_meta["claudecode/toolUseId"]`, stamped by the Claude Code CLI) instead of
  minting a `tlc_<random>` that named nothing. `ToolUseEvent.tool_use_id` is
  the SDK's `toolu_…`, so the old id could never be joined back to the tool
  call that made a twin request — every twin HTTP row stayed an orphan.
  The read is tolerant: an absent or malformed key falls back to a minted id
  rather than throwing, because failing a tool call over a trace-linkage detail
  would be strictly worse than an unjoinable trace.
- **`wrapHandler` no longer discards the handler's second argument.** It called
  `handler(args)` and dropped `extra` outright, so a handler reading
  `extra.signal` saw undefined. Its type signature changes accordingly.
- New exports: `readSdkToolUseId`, `SDK_TOOL_USE_ID_META_KEY`.
- Emitted rows use the new parent vocabulary: `wrapQuery` writes
  `parent_event_id`, hooks write `causing_tool_use_id` and stay rootless.
- Requires `@pome-sh/shared-types@0.14.0`.

## 0.2.5 — 2026-07-30

Dependency-only patch: repin `@pome-sh/shared-types` to 0.13.0 (F-1126). No surface change.

The repin is not cosmetic. npm only symlinks a workspace sibling when the
declared pin matches its version; a stale pin makes npm install a nested
PUBLISHED copy instead, so the package is built and tested against the registry
rather than this tree. `scripts/check-workspace-pins-match-workspace.mjs` now
gates it.

## 0.2.4 — 2026-07-24

F-866 — `tool()`'s return type is widened from `SdkMcpToolDefinition<Schema>` to
`SdkMcpToolDefinition<any>`, while the generic `Schema` still binds from
`inputSchema` so each handler's `args` stay precisely typed. This lets callers
collect tools of differing schemas into one array and hand it to
`createSdkMcpServer({ tools })` (whose param is `SdkMcpToolDefinition<any>[]`)
without a per-call type annotation. The SDK's own precise `<Schema>` return
tripped a cross-copy structural typecheck when the adapter is consumed via a
local `file:` link (a different physical copy of the SDK types than the caller's
`createSdkMcpServer`), surfacing as `TS2322` in the bundled examples. Type-level
only — no runtime or signals-surface change. Patch, not minor: the widening is
more permissive, so no consumer build breaks under the pre-1.0 rule.

## 0.2.3 — 2026-07-21

Dependency-only patch: repin `@pome-sh/shared-types` to 0.12.0 (F-818). No
adapter surface change.

## Unreleased

## 0.2.2 — 2026-07-20

Dependency-only release: `@pome-sh/shared-types` pinned to 0.11.0 for the
first-party Gmail registration contract. No adapter behavior changes.

## 0.2.1 — 2026-07-16

Dependency-only release: `@pome-sh/shared-types` pinned to 0.9.0 after removal
of obsolete local-evaluation hook types. No adapter behavior changes.

## 0.2.0 — 2026-07-16

F-766 — `query()` now emits one `LlmTurnEvent` per assistant turn reporting usage: a `withTurnUsage` stream wrapper (same turn detection as the OTLP `withGenAiSpans` lane) writes `turn_index`, `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `finish_reasons`, and `latency_ms` (+ `latency_ms_estimated`) to the signals JSONL (`POME_ADAPTER_SIGNALS_PATH`; inert when unset). The OTLP lane is untouched. `@pome-sh/shared-types` pin bumped 0.6.0 → 0.8.0 for the `LlmTurnEvent` schema.

Minor, not patch: the adapter's output surface (the signals JSONL) gains a new event kind. A pre-#152 `pome eval` corrupts kinded rows on hosted upload (mapped through `toTwinHttpEvent`), so consumers must pair this adapter with a CLI carrying the F-766 eval fix — consumer-must-act under the pre-1.0 rule in `PACKAGE_RELEASE.md`.

## 0.1.0 — 2026-07-09

First npm-published release (F-714). Drop-in adapter for Anthropic's
`@anthropic-ai/claude-agent-sdk` (peer dependency): `withPome`, `tool`, and
`query` wrap an agent so its tool calls, subagent spawns, and hook events
land in the Pome trace format defined by `@pome-sh/shared-types`.

FDRS-410 — outgoing correlation header renamed from `X-Pome-Tool-Call-Id` to lowercase `x-pome-correlation-id` to match the twin recorders' contract (FDRS-402) and HTTP header-name convention. The exported symbol on the index follows: `TOOL_CALL_HEADER` → `CORRELATION_HEADER`. New `test/als-propagation.test.ts` exercises a tool handler that crosses two microtask boundaries before issuing `fetch()`, asserting exact equality between the entry-time `tool_call_id` (read from ALS) and the outgoing `x-pome-correlation-id` header — fails loudly on the silent-`null`-header failure mode that hid FDRS-322 for weeks.

FDRS-409 — `query()` now emits one `SubagentSpawnEvent` the first time it sees a non-null `parent_tool_use_id` on an SDK message. The spawn row's `parent_id` points at the spawning `ToolUseEvent.event_id` (looked up via `tool_use_id == parent_tool_use_id`); subsequent child `ToolUseEvent`s coming from that sub-agent's message stream carry `parent_id` set to the SubagentSpawnEvent's `event_id`, so child rows chain through the spawn row instead of pointing at null. Same single-writer JSONL path (`POME_ADAPTER_SIGNALS_PATH`); shape matches `subagentSpawnEventSchema` in `@pome-sh/shared-types`.

FDRS-407 — signals are now M0-schema rows; SDK hooks emit `HookEvent`. The legacy `{type: "step"}` and `{type: "tool_call"}` shapes are removed from `signals.ts`. `query()` now merges a read-only `HookEvent` emitter over every entry in the SDK's `HOOK_EVENTS` constant (29 events at impl time: PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged). Each invocation appends one row matching `hookEventSchema` from `@pome-sh/shared-types`: `{ts, event_id, parent_id, kind: "HookEvent", hook_name, tool_name}`. User-supplied hooks in `options.hooks` are preserved alongside pome's. `wrapHandler` keeps the ALS scope that feeds the `X-Pome-Tool-Call-Id` header but no longer writes a signal; `withStepBoundaries` is removed (ToolUseEvent / ToolResultEvent emission moves to FDRS-408's message-stream wrapper).

FDRS-404 — package rename. `@pome-sh/claude-agent-sdk` → `@pome-sh/adapter-claude-sdk`; directory `packages/claude-agent-sdk/` → `packages/adapter-claude-sdk/`. No behavior change. The package was never published to npm under the old name, so this is a no-op for downstream consumers. M2 builds the actual adapter implementation on top of the renamed package; the rename lands in M0 to avoid path collisions with M2's parallel twin-side work.
