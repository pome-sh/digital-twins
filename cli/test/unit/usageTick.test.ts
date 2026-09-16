// SPDX-License-Identifier: Apache-2.0
// The anonymous daily usage tick (F-1832): what turns it off, what it sends,
// that it sends at most once a day, that the notice prints once, and that a
// failed request neither throws nor retries before tomorrow.

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandName,
  FIRST_RUN_NOTICE,
  maybeSendUsageTick,
  telemetryDestination,
  telemetryOptOut,
  usageProperties,
  USAGE_EVENT,
} from "../../src/cli/usageTick.js";

const ENV = { POME_TELEMETRY_KEY: "phc_test", POME_TELEMETRY_HOST: "http://127.0.0.1:1/" };

function fakeFetch(status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function statePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pome-usage-tick-")), ".pome", "telemetry.json");
}

describe("telemetryOptOut", () => {
  it("is off for POME_TELEMETRY=0/false/off/no, DO_NOT_TRACK, and CI", () => {
    for (const value of ["0", "false", "OFF", "no"]) {
      expect(telemetryOptOut({ POME_TELEMETRY: value })).toBe("POME_TELEMETRY");
    }
    expect(telemetryOptOut({ DO_NOT_TRACK: "1" })).toBe("DO_NOT_TRACK");
    expect(telemetryOptOut({ CI: "true" })).toBe("CI");
    expect(telemetryOptOut({ CI: "1" })).toBe("CI");
  });

  it("is on when nothing says otherwise, including DO_NOT_TRACK=0 and CI=false", () => {
    expect(telemetryOptOut({})).toBeUndefined();
    expect(telemetryOptOut({ POME_TELEMETRY: "1" })).toBeUndefined();
    expect(telemetryOptOut({ DO_NOT_TRACK: "0", CI: "false" })).toBeUndefined();
  });
});

describe("telemetryDestination", () => {
  it("needs a key, takes the host from the environment, and strips a trailing slash", () => {
    expect(telemetryDestination({})).toBeUndefined();
    expect(telemetryDestination(ENV)).toEqual({ key: "phc_test", host: "http://127.0.0.1:1" });
    expect(telemetryDestination({ POME_TELEMETRY_KEY: "k" })?.host).toBe("https://us.i.posthog.com");
  });
});

describe("usageProperties + commandName", () => {
  it("sends names and versions, nothing from the invocation", () => {
    expect(usageProperties({ command: "twin start", version: "0.44.0", platform: "darwin", nodeVersion: "v24.18.0" })).toEqual({
      command: "twin start",
      cli_version: "0.44.0",
      os: "darwin",
      node_major: 24,
      $process_person_profile: false,
    });
  });

  it("derives `twin start` from the command tree and drops the root", () => {
    const root = { name: () => "pome", parent: null };
    const twin = { name: () => "twin", parent: root };
    const start = { name: () => "start", parent: twin };
    expect(commandName(start)).toBe("twin start");
    expect(commandName({ name: () => "init", parent: root })).toBe("init");
  });
});

describe("maybeSendUsageTick", () => {
  it("sends once a day with a one-time notice, and keeps the state file owner-only", async () => {
    const path = await statePath();
    const { calls, impl } = fakeFetch();
    const notices: string[] = [];
    const day1 = new Date("2026-09-16T10:00:00Z");

    const first = await maybeSendUsageTick({ command: "twin start", version: "0.44.0", env: ENV, now: day1, statePath: path, fetchImpl: impl, notify: (l) => notices.push(l) });
    expect(first).toEqual({ sent: true });
    expect(notices).toEqual([FIRST_RUN_NOTICE]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:1/capture/");
    expect(calls[0]?.body.event).toBe(USAGE_EVENT);
    expect(calls[0]?.body.api_key).toBe("phc_test");
    expect(typeof calls[0]?.body.distinct_id).toBe("string");
    expect((calls[0]?.body.properties as Record<string, unknown>).command).toBe("twin start");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);

    const again = await maybeSendUsageTick({ command: "twin status", version: "0.44.0", env: ENV, now: new Date("2026-09-16T23:59:00Z"), statePath: path, fetchImpl: impl, notify: (l) => notices.push(l) });
    expect(again).toEqual({ sent: false, reason: "already-today" });
    expect(calls).toHaveLength(1);

    const tomorrow = await maybeSendUsageTick({ command: "twin start", version: "0.44.0", env: ENV, now: new Date("2026-09-17T00:01:00Z"), statePath: path, fetchImpl: impl, notify: (l) => notices.push(l) });
    expect(tomorrow).toEqual({ sent: true });
    expect(calls).toHaveLength(2);
    expect(notices).toHaveLength(1);
    // Same anonymous id across days.
    expect(calls[1]?.body.distinct_id).toBe(calls[0]?.body.distinct_id);
    const state = JSON.parse(await readFile(path, "utf8")) as { id: string; last_sent: string; notice_shown: boolean };
    expect(state).toEqual({ id: calls[0]?.body.distinct_id, last_sent: "2026-09-17", notice_shown: true });
  });

  it("sends nothing when opted out, in CI, or without a key — and never touches the state file", async () => {
    const path = await statePath();
    const { calls, impl } = fakeFetch();
    expect(await maybeSendUsageTick({ command: "init", version: "0", env: { ...ENV, POME_TELEMETRY: "0" }, statePath: path, fetchImpl: impl })).toEqual({ sent: false, reason: "opt-out", detail: "POME_TELEMETRY" });
    expect(await maybeSendUsageTick({ command: "init", version: "0", env: { ...ENV, DO_NOT_TRACK: "1" }, statePath: path, fetchImpl: impl })).toEqual({ sent: false, reason: "opt-out", detail: "DO_NOT_TRACK" });
    expect(await maybeSendUsageTick({ command: "init", version: "0", env: { ...ENV, CI: "true" }, statePath: path, fetchImpl: impl })).toEqual({ sent: false, reason: "opt-out", detail: "CI" });
    expect(await maybeSendUsageTick({ command: "init", version: "0", env: {}, statePath: path, fetchImpl: impl })).toEqual({ sent: false, reason: "no-key" });
    expect(calls).toHaveLength(0);
    await expect(stat(path)).rejects.toThrow();
  });

  it("a failed request does not throw and is not retried until tomorrow", async () => {
    const path = await statePath();
    const failing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const day = new Date("2026-09-16T10:00:00Z");
    const first = await maybeSendUsageTick({ command: "twin start", version: "0", env: ENV, now: day, statePath: path, fetchImpl: failing, notify: () => undefined });
    expect(first).toEqual({ sent: false, reason: "request-failed", detail: "ECONNREFUSED" });
    const { calls, impl } = fakeFetch();
    const second = await maybeSendUsageTick({ command: "twin start", version: "0", env: ENV, now: day, statePath: path, fetchImpl: impl, notify: () => undefined });
    expect(second).toEqual({ sent: false, reason: "already-today" });
    expect(calls).toHaveLength(0);
    const { impl: fiveHundred, calls: c500 } = fakeFetch(500);
    const next = await maybeSendUsageTick({ command: "twin start", version: "0", env: ENV, now: new Date("2026-09-17T10:00:00Z"), statePath: path, fetchImpl: fiveHundred, notify: () => undefined });
    expect(next).toEqual({ sent: false, reason: "request-failed", detail: "HTTP 500" });
    expect(c500).toHaveLength(1);
  });
});
