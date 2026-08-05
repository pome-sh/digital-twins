// SPDX-License-Identifier: Apache-2.0
//
// correlation/fetch — global fetch hook with AsyncLocalStorage gating + host
// allowlist, framework-agnostic.
//
// Locked architecture (FDRS-322 [DECISION] 2026-05-11; moved here unchanged by
// F-950): replace `globalThis.fetch` once, at adapter-init time. Each outbound
// request reads the current tool_call_id from ALS; if absent — i.e. the call did
// not originate inside a wrapped tool handler — the wrapper is a transparent
// passthrough, which is how an agent framework's own traffic (the Anthropic
// SDK's calls to api.anthropic.com) falls through cleanly. The host allowlist is
// the second, independent gate: only configured twin origins ever receive the
// `x-pome-correlation-id` header, never api.anthropic.com and never a third
// party. BOTH gates must pass, so the failure mode of a misconfiguration is a
// missing header, never a leaked one.
//
// WHY PATCH THE GLOBAL AT ALL, rather than hand each twin client an
// instrumented fetch: nothing owns the twin client. A tool handler calls
// `fetch()`, or an MCP client library does, or a generated SDK does — the
// adapter never sees the call site. `globalThis.fetch` is the one seam every one
// of them goes through, and the ALS gate is what makes patching it safe: the
// patch is inert for every request that is not a wrapped tool handler talking to
// a known twin.
//
// FRAMEWORK-AGNOSTIC (F-950): nothing below references any agent SDK. The
// framework-specific half is establishing the ALS scope around a tool
// invocation, which is the adapter's job — see `./context.ts`'s
// `withCorrelation`.

import { currentToolCallId } from "./context.js";

/**
 * The header a pome adapter stamps on outgoing twin requests and every twin's
 * recorder reads back as `TwinHttpEvent.tool_call_id`. Lowercase to match the
 * recorders' contract (FDRS-402) and HTTP header-name convention.
 */
export const CORRELATION_HEADER = "x-pome-correlation-id";

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn | null = null;
let allowlistOrigins: Set<string> = new Set();

function normalizeOrigin(input: string): string | null {
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function isAllowed(input: Parameters<typeof globalThis.fetch>[0]): boolean {
  if (allowlistOrigins.size === 0) return false;
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else url = (input as Request).url;
  const origin = normalizeOrigin(url);
  return origin !== null && allowlistOrigins.has(origin);
}

export interface CorrelationFetchHookOptions {
  /**
   * Twin base URLs. Matched by ORIGIN, so any URL on the same
   * scheme://host:port is covered regardless of path; entries that are not
   * parseable URLs are dropped rather than throwing, because they arrive from
   * environment variables.
   */
  twinHosts: string[];
}

/**
 * Replace `globalThis.fetch` with the correlation-injecting wrapper and set the
 * origin allowlist. Idempotent: a second call updates the allowlist but does NOT
 * wrap again, so the chain never grows and `uninstallCorrelationFetchHook()`
 * always restores the true original.
 */
export function installCorrelationFetchHook(opts: CorrelationFetchHookOptions): void {
  setCorrelationAllowlist(opts.twinHosts);
  if (originalFetch !== null) return;
  originalFetch = globalThis.fetch;
  const wrapper: FetchFn = async (input, init) => {
    const toolCallId = currentToolCallId();
    if (!toolCallId || !isAllowed(input)) {
      return originalFetch!(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(CORRELATION_HEADER, toolCallId);
    const nextInit: RequestInit = { ...(init ?? {}), headers };
    return originalFetch!(input, nextInit);
  };
  globalThis.fetch = wrapper;
}

/** Restore the pre-install `globalThis.fetch` and clear the allowlist. */
export function uninstallCorrelationFetchHook(): void {
  if (originalFetch === null) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  allowlistOrigins = new Set();
}

/** Replace the origin allowlist. Safe to call before or after install. */
export function setCorrelationAllowlist(hosts: string[]): void {
  allowlistOrigins = new Set(
    hosts.map(normalizeOrigin).filter((o): o is string => o !== null),
  );
}

/** The current allowlist, as normalized origins. */
export function getCorrelationAllowlist(): string[] {
  return [...allowlistOrigins];
}
