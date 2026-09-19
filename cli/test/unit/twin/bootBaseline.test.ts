// SPDX-License-Identifier: Apache-2.0
//
// A twin nothing has touched has nothing to diff.
//
// `twin start` snapshots each twin's state at boot, and both `pome twin tape
// --diff` and the dashboard measure `GET /_pome/state` against that snapshot.
// The snapshot came from `harness.exportState()` while the endpoint runs the
// same export through `redactSecrets()`, so a secret that a twin masks its own
// way — linear's token as `lin_…[redacted]` — read differently on the two
// sides, and a freshly booted linear twin reported its tokens and webhooks as
// changed (F-1850). The snapshot is now redacted by the same function, and this
// asserts the invariant for every twin rather than for the one that exposed it.
import { sign } from "hono/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TWIN_NAME_LIST, type TwinName } from "../../../src/twin/registry.js";
import { censusState, diffState } from "../../../src/twin/stateDiff.js";
import { bootTwin } from "../../../src/twin/twinHarness.js";
import { bootBaseline } from "../../../src/twin/twinStart.js";
import { resolveStandaloneSeeds } from "../../../src/twin/twinStartSeed.js";

const SECRET = "boot-baseline-secret-0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the boot snapshot and the live state agree on an untouched twin", () => {
  it.each<TwinName>([...TWIN_NAME_LIST])("%s", async (twin) => {
    vi.stubEnv("TWIN_AUTH_SECRET", SECRET);
    const seeds = await resolveStandaloneSeeds([twin], undefined, {});
    const harness = await bootTwin({
      twin,
      runId: "standalone",
      seedState: seeds.get(twin)!.seedState,
      twinBaseUrl: "http://127.0.0.1:3000",
    });
    try {
      // The function `twinStart` stores the baseline with — not a copy of it.
      const baseline = await bootBaseline(harness);

      // Exactly what the dashboard and `twin tape --diff` read as "now".
      const token = await sign(
        {
          sid: "standalone",
          team_id: "tm_local",
          login: "pome-agent",
          ...(harness.extraClaims ?? {}),
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        SECRET,
      );
      const res = await harness.app.fetch(
        new Request("http://127.0.0.1:3000/s/standalone/_pome/state", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const live = (await res.json()) as unknown;

      expect(diffState(baseline, live)).toEqual([]);
      // And the census the world panel draws from reports nothing moved.
      const moved = censusState(baseline, live).filter(
        (entry) => entry.added.length || entry.changed.length || entry.removed.length,
      );
      expect(moved).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
