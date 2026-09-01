<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/wire

The trace surface every Pome process agrees on — Zod schemas and TypeScript
types for recorder events, the OpenTelemetry extension of that union, secret
redaction, and framework-agnostic tool-call correlation. The `pome` CLI, the twin
engine (`@pome-sh/sdk`), the first-party twins and the Claude adapter all speak
this vocabulary; the wire format is the contract, not any one library.

Internal infrastructure, published two ways and installed by end users through
neither:

- **Bundled** — the CLI and the Claude adapter inline it into their single
  bundles (`cli/tsup.config.ts` `noExternal`), and the twin images copy its
  built `dist/`. Both declare it as a `devDependency` at `"*"`, so no published
  npm tarball has an `@pome-sh/wire` dependency and nothing on npmjs resolves
  it. This is how every consumer *inside this repo* gets it.
- **Published to GitHub Packages** (`npm.pkg.github.com`, not npmjs) as an
  independently versioned artifact, for consumers in *other repositories* —
  today that means `pome-sh/pome-cloud`, which needs the same trace vocabulary
  and must not fork a second copy of these Zod schemas. Reading it requires a
  GitHub token; it is not an end-user install surface and has no public API
  promise.

## What is NOT here

Sessions, tasks, runs, the `/v1` REST surface, error envelopes and the
`pome.json` manifest are the cloud control-plane contract, not the wire trace
surface. They live in [`cli/src/contract/`](../../cli/src/contract).
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

The agent-side half of tool-call correlation, with no agent framework in it.
A twin records one `TwinHttpEvent` per inbound request; for that row to
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
`_meta["claudecode/toolUseId"]` key, the Vercel AI SDK exposes `toolCallId` on
the tool-call part, LangGraph on the `ToolCall`. None of them needs to re-derive
the store or the fetch patch.

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
