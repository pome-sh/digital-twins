<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/wire

The trace surface every Pome process agrees on — Zod schemas and TypeScript
types for recorder events, the OpenTelemetry extension of that union, secret
redaction, and framework-agnostic tool-call correlation. The `pome` CLI, the twin
engine (`@pome-sh/sdk`), the first-party twins and the Claude adapter all speak
this vocabulary; the wire format is the contract, not any one library.

Internal (`private: true`): it is never published. The CLI inlines it into its
single bundle (`cli/tsup.config.ts` `noExternal`), and the twin images copy its
built `dist/`.

## What is NOT here

Sessions, tasks, runs, the `/v1` REST surface, error envelopes and the
`pome.json` manifest are the cloud control-plane contract, not the wire trace
surface. They live in [`cli/src/contract/`](../../cli/src/contract) (F-942).
GitHub's sandbox access-control catalog lives in
[`packages/twin-github/src/access-control.ts`](../twin-github/src/access-control.ts),
next to the tools it describes.

## Usage

```ts
import { recorderEventSchema, redactSecrets } from "@pome-sh/wire";
import { eventSchema } from "@pome-sh/wire/recorder-events";

const event = recorderEventSchema.parse(row);
const safe = redactSecrets(JSON.stringify(event));
```

Subpath exports: `recorder-events`, `otel`, `otel/fixtures`, `redaction`, and
`correlation`. `zod` (^4.1.13) is a peer dependency.

## `@pome-sh/wire/correlation`

The agent-side half of tool-call correlation, with no agent framework in it
(F-950). A twin records one `TwinHttpEvent` per inbound request; for that row to
name the tool call that caused it, the agent side has to stamp the id on an
outgoing header. This module is that mechanism: an `AsyncLocalStorage` store —
which is what makes it race-proof when several tool calls run concurrently — plus
a `globalThis.fetch` patch gated on both that store and an origin allowlist, so
only configured twin origins ever see the header and the framework's own traffic
(api.anthropic.com) passes through untouched.

```ts
import {
  installCorrelationFetchHook,
  withCorrelation,
  generateToolCallId,
} from "@pome-sh/wire/correlation";

installCorrelationFetchHook({ twinHosts: ["http://127.0.0.1:3333"] }); // once, at init

// at each tool invocation the framework dispatches
const id = readFrameworkToolCallId(call) ?? generateToolCallId();
return withCorrelation(id, () => handler(args));
```

`readFrameworkToolCallId` is the only framework-shaped line, and it is all an
adapter owns: the Claude Agent SDK puts the id on an MCP
`_meta["claudecode/toolUseId"]` key (see
[`packages/adapter-claude-sdk/src/wrapHandler.ts`](../adapter-claude-sdk/src/wrapHandler.ts)),
the Vercel AI SDK exposes `toolCallId` on the tool-call part, LangGraph on the
`ToolCall`. None of them needs to re-derive the store or the fetch patch.

Subpath-only, not on the root barrel: importing it constructs an
`AsyncLocalStorage`, and no twin, the sdk or the CLI is the agent side of this
protocol.

## trace-contract.json

The machine-readable descriptor of this package's trace surface. Its
`eventKinds` map is enumerated from the zod event union at emit time and lists
the wire fixture backing each kind — adding a union member without a fixture
fails `npm run check:trace-contract -w @pome-sh/wire` (see
`test/fixtures/v1/README.md`).

## License

Apache-2.0.
