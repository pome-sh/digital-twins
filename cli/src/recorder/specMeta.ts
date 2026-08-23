// SPDX-License-Identifier: Apache-2.0
//
// meta.json contract constants (D18.1). `spec_version` and
// the twin package versions let cloud's ingest validate that a run's meta.json
// matches a shape it knows how to parse, and let the dashboard attribute a
// run's captured behavior to the exact twin build that produced it.
//
// Versions come from each twin's OWN package.json `version`, inlined into its
// `TWIN_REGISTRY` entry at build time — never from the dependency SPEC in the
// CLI's own package.json (a workspace `"*"` link says nothing about the
// version), and never the CLI's own version (cloud ingest would silently
// mis-attribute every run).
//
// This used to resolve the version at RUNTIME via
// `createRequire(import.meta.url).resolve("@pome-sh/twin-<id>")` plus a walk-up
// for the matching manifest. That cannot survive bundling: the twins are inlined
// into the CLI bundle, so there is no `@pome-sh/twin-*` package directory left
// to resolve and every version would silently go MISSING from meta.json. The
// build-time import is resolved by the compiler/bundler instead, so the reported
// values are identical and cannot drift from the twin that actually ran.

import { isTwinName, TWIN_REGISTRY } from "../twin/registry.js";

// Bump when the meta.json SHAPE changes in a way a consumer must branch on
// (new required field, renamed key, etc.). Purely additive fields don't need
// a bump.
export const META_SPEC_VERSION = 1;

/** Resolve twin package versions for the given twin ids (e.g.
 *  `scenario.config.twins`). A twin id with no registry entry (an unknown or
 *  misspelled id) is OMITTED — never fabricated. Key insertion order follows
 *  the caller's id order, exactly as the previous implementation did. */
export function resolveTwinPackageVersions(twinIds: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of twinIds) {
    if (isTwinName(id)) out[id] = TWIN_REGISTRY[id].version;
  }
  return out;
}
