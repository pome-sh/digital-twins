// SPDX-License-Identifier: Apache-2.0
//
// `withPome()` — the one-call init contract.
//
// Default behavior (no opts): infer twin allowlist from `POME_*_BASE_URL` and
// `POME_*_MCP_URL` env vars (CLI runner injects these when running scenarios).
// Standalone dev mode without env vars → empty allowlist, adapter inert on
// header injection but still wires ALS + signals fallback noop.
//
// The fetch hook itself is framework-agnostic and lives in
// `@pome-sh/wire/correlation`; what is Claude-adapter-specific here is
// only the one-call `withPome()` contract and the `POME_*` env conventions the
// CLI runner injects.

import {
  getCorrelationAllowlist,
  installCorrelationFetchHook,
  uninstallCorrelationFetchHook,
} from "@pome-sh/wire/correlation";
import { ensureOtel } from "./otel.js";

export interface WithPomeOptions {
  twinHosts?: string[];
}

let installed = false;

const ENV_PREFIXES_SUFFIXES: Array<[string, string]> = [
  ["POME_", "_BASE_URL"],
  ["POME_", "_MCP_URL"],
];

function inferTwinHostsFromEnv(): string[] {
  const out = new Set<string>();
  for (const [prefix, suffix] of ENV_PREFIXES_SUFFIXES) {
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const value = process.env[key];
      if (!value) continue;
      try {
        out.add(new URL(value).origin);
      } catch {
        /* ignore malformed env URL */
      }
    }
  }
  return [...out];
}

export function withPome(opts: WithPomeOptions = {}): void {
  if (installed) return;
  const twinHosts = opts.twinHosts ?? inferTwinHostsFromEnv();
  installCorrelationFetchHook({ twinHosts });
  // Stand up the OTLP/JSON trace exporter when the CLI configured an endpoint.
  // No-op (returns null) in standalone dev, so this stays a safe one-call init.
  ensureOtel();
  installed = true;
}

export function getInstalledTwinHosts(): string[] {
  return getCorrelationAllowlist();
}

export function _resetInitForTest(): void {
  uninstallCorrelationFetchHook();
  installed = false;
}
