// SPDX-License-Identifier: Apache-2.0
//
// The poll (F-1850 · D5). One request, both halves, every 500 ms.
//
// One endpoint and not two on purpose: fetching the tape and the state
// separately lets them fall out of step by a round trip, which is exactly what
// would break the rule that a row landing and its count ticking read as one
// beat. Upstream the two reads are still separate, so the pairing is eventual
// rather than atomic — it converges on the next tick, and nothing here is
// designed to need more than that.
//
// Paused while the tab is hidden: a forgotten tab should not keep a twin
// answering twice a second for an afternoon.
import { useEffect, useRef, useState } from "react";
import type { SnapshotResponse, TwinSnapshot } from "./api.js";

export const TICK_MS = 500;

/**
 * Consecutive failed polls after which the page stops asking. The server goes
 * when `twin start` does, and it never comes back at this address: a new start
 * binds a new port with a new key. Ten seconds of silence is a stopped session,
 * not a slow one.
 */
const GIVE_UP_AFTER = 20;

/** The dashboard key, handed to the page in the URL the CLI printed. */
function dashboardKey(): string {
  return new URLSearchParams(window.location.search).get("k") ?? "";
}

export type Feed = {
  twins: TwinSnapshot[];
  /** False until the first response lands, so the page can hold its peace. */
  ready: boolean;
  /** The server itself stopped answering — the whole `twin start` is gone. */
  gone: boolean;
};

export function useSnapshot(): Feed {
  const [feed, setFeed] = useState<Feed>({ twins: [], ready: false, gone: false });
  // Last good snapshot per twin. A twin that stops answering keeps its tape on
  // screen — "the tape above is everything that was recorded" only reads true
  // if the tape is still there.
  const lastGood = useRef(new Map<string, TwinSnapshot>());

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let misses = 0;

    const tick = async () => {
      if (!live) return;
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(tick, TICK_MS);
        return;
      }
      try {
        const res = await fetch(`/api/snapshot?k=${encodeURIComponent(dashboardKey())}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as SnapshotResponse;
        if (!live) return;
        const twins = body.twins.map((twin) => {
          if (twin.reachable) {
            lastGood.current.set(twin.name, twin);
            return twin;
          }
          const held = lastGood.current.get(twin.name);
          return held === undefined ? twin : { ...held, reachable: false };
        });
        misses = 0;
        setFeed({ twins, ready: true, gone: false });
      } catch {
        misses += 1;
        if (live) setFeed((prior) => ({ ...prior, gone: prior.ready }));
      }
      if (live && misses < GIVE_UP_AFTER) timer = window.setTimeout(tick, TICK_MS);
    };

    void tick();
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return feed;
}
