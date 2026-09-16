// SPDX-License-Identifier: Apache-2.0
// `.pome/twin-status.json` carries the twin's bearer JWT, so it is written
// owner-only like every other secret the CLI writes (F-1800).

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeStandaloneStatusFile, type StandaloneStatus } from "../../src/twin/twinStart.js";

const STATUS: StandaloneStatus = {
  name: "github",
  url: "http://127.0.0.1:3333/s/standalone",
  rest_url: "http://127.0.0.1:3333/s/standalone",
  mcp_url: "http://127.0.0.1:3333/s/standalone/mcp",
  auth_token: "not-a-real-token",
};

const posix = process.platform !== "win32";

describe("writeStandaloneStatusFile", () => {
  it.skipIf(!posix)("creates the directory 0700 and the file 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-status-"));
    const path = join(dir, ".pome", "twin-status.json");
    await writeStandaloneStatusFile(STATUS, path);
    expect((await stat(join(dir, ".pome"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(STATUS);
  });

  it.skipIf(!posix)("tightens a status file an older CLI left world-readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-status-"));
    const path = join(dir, "twin-status.json");
    await writeFile(path, "{}", { mode: 0o644 });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await writeStandaloneStatusFile(STATUS, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(STATUS);
  });
});

describe("snapshotStandaloneInitialState", () => {
  it("removes an earlier boot's snapshot before taking this one, so a failed export leaves none", async () => {
    const { snapshotStandaloneInitialState, readStandaloneInitialState } = await import(
      "../../src/twin/twinStatusFile.js"
    );
    const dir = join(await mkdtemp(join(tmpdir(), "pome-twin-snapshot-")), "twin-state");
    await snapshotStandaloneInitialState("github", () => ({ repositories: [] }), dir);
    expect(await readStandaloneInitialState("github", dir)).toEqual({ repositories: [] });

    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => { errors.push(line); };
    try {
      await snapshotStandaloneInitialState(
        "github",
        () => { throw new Error("state introspection is not configured for this twin"); },
        dir,
      );
    } finally {
      console.error = original;
    }
    expect(await readStandaloneInitialState("github", dir)).toBeUndefined();
    expect(errors.join("\n")).toContain("could not snapshot the github twin's state");
  });
});
