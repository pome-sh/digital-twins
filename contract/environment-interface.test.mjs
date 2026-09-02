// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { freePort, mintSessionJwt, req, spawnTwin, TWINS } from "./helpers.mjs";

for (const twin of TWINS) {
  test(`${twin.name}: port precedence, no-seed, and durable recorder environment`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), `pome-contract-${twin.name}-`));
    const eventsPath = path.join(directory, "events.jsonl");
    const seeded = await spawnTwin(twin);
    const ignoredProviderPort = await freePort();
    const portPrecedence = await spawnTwin(twin, {
      env: { [twin.portEnv]: String(ignoredProviderPort) },
    });
    const empty = await spawnTwin(twin, {
      providerPort: true,
      env: {
        [twin.noSeedEnv]: "1",
        POME_SEED_JSON: "not-json",
        POME_RECORDER_EVENTS_PATH: eventsPath,
      },
    });

    t.after(async () => {
      await Promise.all([seeded.close(), portPrecedence.close(), empty.close()]);
      await rm(directory, { recursive: true, force: true });
    });

    const sid = "env-contract";
    const token = mintSessionJwt({ sid });
    const seededState = await req(seeded.base, `/s/${sid}/_pome/state`, { token });
    const emptyState = await req(empty.base, `/s/${sid}/_pome/state`, { token });

    assert.equal(seededState.status, 200);
    assert.equal(emptyState.status, 200);
    if (twin.name !== "stripe") {
      assert.notDeepEqual(emptyState.json, seededState.json, `${twin.noSeedEnv}=1 must skip the default seed`);
    }

    await req(empty.base, `/s/${sid}/contract-recorder-probe`, { token });
    const rows = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.path.endsWith("/contract-recorder-probe")));
  });
}
