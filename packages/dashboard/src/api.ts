// SPDX-License-Identifier: Apache-2.0
//
// The wire shape between the loopback dashboard server (`cli/src/dashboard/`)
// and this page. Declared HERE, in the consumer, and imported type-only by the
// producer — so `npm run typecheck -w @pome-sh/cli` fails the day the server
// stops satisfying it. That is what makes this a checked contract rather than a
// mirror of `cli/src/twin/twinTape.ts` that drifts in silence: the row and diff
// shapes below are structural, so the CLI's own `TapeRow` and `CollectionDiff`
// must stay assignable to them.
//
// Deliberately NOT re-exported from `@pome-sh/wire`: nothing outside this
// machine ever sees these bytes. They are a local render contract, not a
// published one, and putting them in wire would freeze them under
// CONTRACT.md's change procedure for no gain.

/** A per-request row, as `pome twin tape` computes it (`twinTape.ts`). */
export type TapeRow = {
  ts: string;
  method: string;
  /** Path relative to the session (`/repos/acme/api`, `/mcp`). */
  path: string;
  tool: string | null;
  status: number;
  fidelity: string;
  state_mutation: boolean;
  error: string | null;
  kind: "read" | "write";
  /** The mark a reader must not miss ("write did not land (404)"), or null. */
  note: string | null;
};

/**
 * The twin's own row-level before/after for this request, verbatim — wire's
 * type, not a copy of it, so a change to the recorded shape reds this page's
 * typecheck instead of surfacing as a blank panel at runtime.
 *
 * `null` is the common case and an honest one: reads report nothing, and a
 * write that did not land reports nothing either. The page must say so rather
 * than render an empty panel. The CONTENTS stay `unknown` because wire says
 * "per-twin types are NOT enforced", and F-1850's review confirmed the shapes
 * genuinely differ — github sends a flat entity, gmail a wrapper, linear a
 * whole collection. Anything reading these must tolerate all three.
 */
export type { StateDelta } from "@pome-sh/wire";

export type TapeEntry = TapeRow & { delta: import("@pome-sh/wire").StateDelta };

export type TapeSummary = {
  requests: number;
  changed_state: number;
  writes_not_landed: number;
  unsupported: number;
  reads: number;
};

/**
 * One collection of the twin's world, keyed by its path in the state tree
 * (`repositories[acme/api].issues`). Path-keyed rather than name-keyed on
 * purpose: github exports `labels` at BOTH repo and issue level, so counting by
 * name double-counts, while these two paths are distinct rows that each count
 * once.
 */
export type WorldCollection = {
  path: string;
  boot: number;
  now: number;
  /**
   * `membership` is an array of scalars — a join table (`issue.labelIds`,
   * `channel.members`). Real state, but never what a reader is looking at.
   */
  kind: "collection" | "membership";
  /** Identities added / changed / removed since boot, as `diffState` names them. */
  added: string[];
  changed: string[];
  removed: string[];
};

export type TwinSnapshot = {
  name: string;
  /** The twin's session URL, for the connect snippet and the header. */
  url: string;
  /** Whether the twin answered this poll. False once the operator hits Ctrl-C. */
  reachable: boolean;
  entries: TapeEntry[];
  /**
   * Events the tape holds beyond the ones in `entries`. The in-memory recorder
   * is unbounded, so the endpoint caps what it ships; `summary` is still
   * computed over every event, so the verdict never lies about the total.
   */
  dropped: number;
  summary: TapeSummary;
  world: WorldCollection[];
  /** The ready-to-paste connect block, as the `twin start` banner prints it. */
  connect: ConnectSnippet;
};

/**
 * What the empty state teaches: the three ways the `twin start` banner offers
 * to point an agent at this twin, and the export line two of them depend on.
 */
export type ConnectSnippet = {
  /** `export POME_AUTH_TOKEN=…` — the twin's URLs and the token, on one line. */
  exportLine: string;
  /** The same line with the token masked, for a page that may be photographed. */
  exportLineMasked: string;
  /** Project-scope `.mcp.json`. Reads `${POME_AUTH_TOKEN}`; carries no token. */
  mcpJson: string;
  /**
   * `claude mcp add …` — self-contained, so it DOES carry the token, which is
   * why it has a masked twin too. The one form that needs no export first.
   */
  claudeCode: string;
  claudeCodeMasked: string;
  /** `~/.codex/config.toml` stanza. Names the env var; carries no token. */
  codexToml: string;
};

export type SnapshotResponse = {
  ts: string;
  twins: TwinSnapshot[];
};
