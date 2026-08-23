// SPDX-License-Identifier: Apache-2.0
//
// Twin-agnostic in-process boot for the self-host runner.
//
// `bootTwin` is a thin wrapper over `TWIN_REGISTRY`: given a twin name + the
// scenario's (already twin-shaped) seed state, it stands up the matching
// in-process twin app, seeds it, and exposes a uniform surface the runner drives
// regardless of twin —
//   - `app`         a Hono app (`.fetch`) the runner serves on a localhost port
//   - `envName`     the `POME_<NAME>_{REST,MCP}_URL` prefix the agent reads
//   - `exportState` initial/final twin state for deterministic `[code]` scoring
//   - `events`      recorded twin HTTP events (one shared recorder buffer)
//   - `close`       tear down the underlying SQLite handle
//
// Everything twin-specific — which package to import, the seed shape, the env
// prefix, the extra JWT claims — lives in that twin's registry entry. This file
// owns only the recorder lifecycle, which is shared across twins.
import { createRecorder, type Recorder } from "../recorder/recorder.js";
import type { RecorderEvent } from "@pome-sh/wire";
import { isTwinName, TWIN_NAMES, TWIN_REGISTRY, type TwinApp } from "./registry.js";

export { STRIPE_LOCAL_ACCOUNT_ID } from "./registry.js";

export type TwinHarness = {
  /** Hono app the runner serves at `http://127.0.0.1:<port>`. */
  app: TwinApp;
  /** Uppercase env prefix: the agent reads `POME_<envName>_{REST,MCP}_URL`. */
  envName: string;
  /** Twin state for `[code]` scoring (initial before the agent, final after). */
  exportState(): unknown | Promise<unknown>;
  /** Recorded twin HTTP events (shared buffer). */
  events(): RecorderEvent[];
  /** Extra JWT claims the runner mints into the agent token (e.g. Stripe's
   *  `account_id`, so the token resolves to the account the seed lives in). */
  extraClaims?: Record<string, unknown>;
  /** Provider-specific bearer alias, when the provider SDK expects one. */
  tokenEnvName?: string;
  /**
   * Durability barrier for the twin recorder without closing the DB.
   * Call before finalize/merge so pending TwinHttpEvent rows land on disk
   * before `events.jsonl` is rewritten.
   */
  flush(): void | Promise<void>;
  /** Flush durable recorder (if any) and release the SQLite handle. */
  close(): void | Promise<void>;
};

export class UnsupportedTwinError extends Error {
  constructor(public readonly twin: string) {
    super(
      `Self-hosted local runs do not support the '${twin}' twin yet. ` +
        `Supported: ${TWIN_NAMES.join(", ")}.`,
    );
    this.name = "UnsupportedTwinError";
  }
}

export async function bootTwin(opts: {
  twin: string;
  seedState: unknown;
  runId: string;
  twinBaseUrl?: string;
  /**
   * When set, twin HTTP events stream to this NDJSON path via the
   * twin-core durable recorder (same file capture-server appends to).
   */
  eventsPath?: string;
  /**
   * Multi-twin (M3): a SHARED recorder so every twin harness in one local run
   * buffers into a single events stream / events.jsonl. When provided, this
   * harness does NOT own the recorder — `close()` releases only its DB handle
   * and the caller is responsible for `flush()`/`close()` on the recorder. When
   * omitted (single-twin), the harness creates and owns its own recorder, so
   * `close()` flushes + closes it exactly as before.
   */
  recorder?: Recorder;
}): Promise<TwinHarness> {
  if (!isTwinName(opts.twin)) throw new UnsupportedTwinError(opts.twin);
  const entry = TWIN_REGISTRY[opts.twin];

  const ownsRecorder = opts.recorder === undefined;
  const recorder = opts.recorder ?? createRecorder({ eventsPath: opts.eventsPath });

  const flushRecorder = async () => {
    await recorder.flush?.();
  };

  const booted = await entry.boot({
    seedState: opts.seedState,
    runId: opts.runId,
    twinBaseUrl: opts.twinBaseUrl,
    recorder,
  });

  return {
    app: booted.app,
    envName: entry.envName,
    exportState: () => booted.exportState(),
    events: () => recorder.events(),
    ...(booted.extraClaims ? { extraClaims: booted.extraClaims } : {}),
    ...(entry.tokenEnvName ? { tokenEnvName: entry.tokenEnvName } : {}),
    flush: () => flushRecorder(),
    close: async () => {
      await flushRecorder();
      // A shared recorder is owned by the caller — only flush here, never close
      // it out from under sibling harnesses still writing to it.
      if (ownsRecorder) await recorder.close?.();
      booted.closeDb();
    },
  };
}
