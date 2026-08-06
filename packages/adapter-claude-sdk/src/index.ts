// SPDX-License-Identifier: Apache-2.0
//
// `@pome-sh/adapter-claude-sdk` — adapter package v0.
//
// One-import surface for users of Anthropic's `claude-agent-sdk` who want
// pome step-boundary + tool-call signals overlaid on the trace. See README.md
// for the full architecture; the [DECISION] comment on FDRS-322 captures the
// rationale for the wrap-and-re-export design (vs. global fetch monkey-patch,
// sidechannel-only correlator merge, etc.).
//
// Typical use:
//
//     import { withPome, tool, query } from "@pome-sh/adapter-claude-sdk";
//
//     withPome(); // installs globalThis.fetch hook + signals writer
//
//     const myTool = tool("name", "desc", schema, handler);
//     for await (const msg of query({ prompt, options: { ... } })) { ... }
//
// F-950: the correlation core this package used to own — the AsyncLocalStorage
// store and the `x-pome-correlation-id` fetch injection — now lives in
// `@pome-sh/wire/correlation`, framework-agnostic, so a Vercel AI SDK or
// LangGraph adapter gets the same race-proof guarantee instead of re-deriving
// it. `CORRELATION_HEADER` is re-exported from there and is unchanged for
// consumers. What stays Claude-specific is the wrapping: `tool()`, `query()`,
// and reading the SDK's own `tool_use_id` off the MCP `_meta` key.

export { withPome, getInstalledTwinHosts } from "./init.js";
export type { WithPomeOptions } from "./init.js";
export { tool } from "./tool.js";
export { query } from "./query.js";
export { CORRELATION_HEADER } from "./correlation.js";
export { ADAPTER_SIGNALS_ENV } from "./signals.js";
export {
  flushPomeTelemetry,
  OTEL_ENDPOINT_ENV,
  OTEL_HEADERS_ENV,
} from "./otel.js";
