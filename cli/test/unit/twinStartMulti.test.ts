// SPDX-License-Identifier: Apache-2.0
// `pome twin start github slack linear` boots several twins in one process
// (F-1836). These pin the pieces that decide what happens before anything
// binds: which twins, on which ports, from which seeds, under which secret —
// and what the status file looks like once a second command joins the first.
// The single-twin path must come out of every helper unchanged.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TWIN_REGISTRY } from "../../src/twin/registry.js";
import {
  chooseStandalonePorts,
  mergeStandaloneStatus,
  resolveStandaloneAuthSecretFor,
  resolveStandaloneSeeds,
  resolveStandaloneTwins,
  standaloneStatusEntries,
  updateStandaloneStatusFile,
  type StandaloneAuthSecret,
  type StandaloneStatus,
} from "../../src/twin/twinStart.js";

const FLAT_GITHUB = {
  users: [{ login: "vakoi", type: "Organization", name: "Vakoi" }],
  repositories: [{ owner: "vakoi", name: "billing" }],
};

async function seedFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-twin-start-multi-"));
  const path = join(dir, "seed.json");
  await writeFile(path, contents);
  return path;
}

function repoNames(seedState: unknown): string[] {
  const seed = seedState as { repositories: { owner: string; name: string }[] };
  return seed.repositories.map((repo) => `${repo.owner}/${repo.name}`);
}

describe("resolveStandaloneTwins", () => {
  it("returns the names in argument order", () => {
    expect(resolveStandaloneTwins(["github", "slack", "linear"], undefined, undefined)).toEqual([
      "github",
      "slack",
      "linear",
    ]);
  });

  it("refuses an unknown name, listing every supported twin", () => {
    expect(() => resolveStandaloneTwins(["github", "nope"], undefined, undefined)).toThrow(
      /Unknown twin 'nope'\. Supported: github, .*linear\./,
    );
  });

  it("refuses a name given twice", () => {
    expect(() => resolveStandaloneTwins(["github", "github"], undefined, undefined)).toThrow(
      "'github' is named twice",
    );
  });

  it("with no names, defers to the one twin the --seed envelope names", () => {
    const text = JSON.stringify({ slack: { channels: [] } });
    expect(resolveStandaloneTwins([], "seed.json", text)).toEqual(["slack"]);
  });

  it("with no names and no seed, says what is missing", () => {
    expect(() => resolveStandaloneTwins([], undefined, undefined)).toThrow("name a twin");
  });
});

describe("chooseStandalonePorts", () => {
  const freeExcept = (busy: number[]) => async (port: number) => !busy.includes(port);

  it("one twin: --port, else $PORT, else the twin's own default — and no probe", async () => {
    let probed = 0;
    const probe = async () => {
      probed += 1;
      return true;
    };
    expect(await chooseStandalonePorts(["github"], "4100", {}, probe)).toEqual([4100]);
    expect(await chooseStandalonePorts(["github"], undefined, { PORT: "4200" }, probe)).toEqual([4200]);
    expect(await chooseStandalonePorts(["linear"], undefined, {}, probe)).toEqual([3337]);
    expect(
      await chooseStandalonePorts(["gmail"], undefined, { GMAIL_TWIN_PORT: "4300" }, probe),
    ).toEqual([4300]);
    expect(probed).toBe(0);
  });

  it("one twin: an invalid --port is refused as before", async () => {
    await expect(chooseStandalonePorts(["github"], "0", {}, freeExcept([]))).rejects.toThrow(
      'invalid --port "0"',
    );
  });

  it("several twins: each takes its default port, else the next free one", async () => {
    // github, slack and stripe all default to 3333; linear to 3337.
    expect(
      await chooseStandalonePorts(["github", "slack", "linear"], undefined, {}, freeExcept([])),
    ).toEqual([3333, 3334, 3337]);
    expect(
      await chooseStandalonePorts(
        ["github", "stripe", "slack"],
        undefined,
        {},
        freeExcept([3333, 3334]),
      ),
    ).toEqual([3335, 3336, 3337]);
  });

  it("several twins: $PORT is every twin's default, so the rest move up from it", async () => {
    expect(
      await chooseStandalonePorts(["github", "slack"], undefined, { PORT: "5000" }, freeExcept([])),
    ).toEqual([5000, 5001]);
  });

  it("several twins: --port is the first twin's port exactly; the rest count up from it", async () => {
    expect(
      await chooseStandalonePorts(["github", "slack", "linear"], "4000", {}, freeExcept([4001])),
    ).toEqual([4000, 4002, 4003]);
  });

  it("gives up after 200 busy ports, naming the twin", async () => {
    await expect(
      chooseStandalonePorts(["github", "slack"], undefined, {}, async () => false),
    ).rejects.toThrow("no free port for the github twin");
  });
});

describe("resolveStandaloneSeeds", () => {
  it("several twins with no seed: each twin's own default", async () => {
    const seeds = await resolveStandaloneSeeds(["github", "slack"], undefined, {});
    expect([...seeds.keys()]).toEqual(["github", "slack"]);
    expect(seeds.get("github")?.source).toBe("default");
    expect(repoNames(seeds.get("github")?.seedState)).toContain("acme/api");
    expect(seeds.get("slack")?.source).toBe("default");
  });

  it("a flat seed with several names is refused, naming the mismatch", async () => {
    const path = await seedFile(JSON.stringify(FLAT_GITHUB));
    await expect(resolveStandaloneSeeds(["github", "slack"], path, {})).rejects.toThrow(
      /is a flat seed for one twin, and pome twin start was given 2 names \(github, slack\)/,
    );
  });

  it("an envelope seeds each named twin from its own entry", async () => {
    const path = await seedFile(
      JSON.stringify({ github: FLAT_GITHUB, slack: { channels: [{ id: "C1", name: "eng-alerts" }] } }),
    );
    const seeds = await resolveStandaloneSeeds(["github", "slack"], path, {});
    expect(repoNames(seeds.get("github")?.seedState)).toEqual(["vakoi/billing"]);
    const slack = seeds.get("slack")?.seedState as { channels: { name: string }[] };
    expect(slack.channels.map((c) => c.name)).toEqual(["eng-alerts"]);
    expect(seeds.get("github")).toMatchObject({ source: "file", path });
  });

  it("an envelope missing a named twin is refused by name, as it is for one twin", async () => {
    const path = await seedFile(JSON.stringify({ github: FLAT_GITHUB }));
    await expect(resolveStandaloneSeeds(["github", "slack"], path, {})).rejects.toThrow(
      /declares no slack seed \(it names github\)/,
    );
  });

  it("an envelope naming an extra twin is tolerated, as it is for one twin", async () => {
    const path = await seedFile(
      JSON.stringify({
        github: FLAT_GITHUB,
        slack: { channels: [] },
        linear: await TWIN_REGISTRY.linear.defaultSeed(),
      }),
    );
    const seeds = await resolveStandaloneSeeds(["github", "slack"], path, {});
    expect([...seeds.keys()]).toEqual(["github", "slack"]);
  });

  it("POME_SEED_JSON is the same door for several twins", async () => {
    const seeds = await resolveStandaloneSeeds(["github", "slack"], undefined, {
      POME_SEED_JSON: JSON.stringify({ github: FLAT_GITHUB, slack: { channels: [] } }),
    });
    expect(seeds.get("github")?.source).toBe("env");
    expect(repoNames(seeds.get("github")?.seedState)).toEqual(["vakoi/billing"]);
  });
});

describe("resolveStandaloneAuthSecretFor", () => {
  const persistedFrom = (byTwin: Record<string, string>) => (twin: string): StandaloneAuthSecret =>
    twin in byTwin
      ? { secret: byTwin[twin]!, source: "persisted", path: `.pome-data/${twin}/secret` }
      : { secret: `ephemeral-${twin}`, source: "ephemeral" };

  it("env wins for several twins", () => {
    const resolved = resolveStandaloneAuthSecretFor(["github", "slack"], {
      TWIN_AUTH_SECRET: "from-env-0123456789abcdef0123456789",
    });
    expect(resolved).toEqual({ secret: "from-env-0123456789abcdef0123456789", source: "env" });
  });

  it("one persisted secret among the twins is shared by all, naming its file", () => {
    const resolved = resolveStandaloneAuthSecretFor(
      ["github", "slack"],
      {},
      persistedFrom({ slack: "s".repeat(40) }),
    );
    expect(resolved).toEqual({
      secret: "s".repeat(40),
      source: "persisted",
      path: ".pome-data/slack/secret",
    });
  });

  it("two different persisted secrets are refused, naming both files", () => {
    expect(() =>
      resolveStandaloneAuthSecretFor(
        ["github", "slack"],
        {},
        persistedFrom({ github: "g".repeat(40), slack: "s".repeat(40) }),
      ),
    ).toThrow(".pome-data/github/secret and .pome-data/slack/secret hold different secrets");
  });

  it("no persisted secret means one fresh secret for the whole process", () => {
    const resolved = resolveStandaloneAuthSecretFor(["github", "slack"], {}, persistedFrom({}));
    expect(resolved.source).toBe("ephemeral");
    expect(resolved.secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mergeStandaloneStatus", () => {
  const entry = (name: StandaloneStatus["name"], port: number): StandaloneStatus => ({
    name,
    url: `http://127.0.0.1:${port}/s/standalone`,
    rest_url: `http://127.0.0.1:${port}/s/standalone`,
    mcp_url: `http://127.0.0.1:${port}/s/standalone/mcp`,
    auth_token: `token-${name}`,
  });

  it("upgrades an older single-twin file into one entry and adds the new twin beside it", () => {
    const merged = mergeStandaloneStatus(entry("github", 3333), [entry("slack", 3334)]);
    expect(Object.keys(merged.twins)).toEqual(["github", "slack"]);
    // The top-level fields mirror the twin just started — what a reader of
    // the older shape (`jq -r .rest_url`) always saw after `twin start`.
    expect(merged.name).toBe("slack");
    expect(merged.rest_url).toBe("http://127.0.0.1:3334/s/standalone");
    expect(merged.auth_token).toBe("token-slack");
  });

  it("keeps other twins' entries and overwrites the same name", () => {
    const first = mergeStandaloneStatus(undefined, [entry("github", 3333), entry("slack", 3334)]);
    const merged = mergeStandaloneStatus(first, [entry("github", 4000)]);
    expect(merged.twins.github?.rest_url).toBe("http://127.0.0.1:4000/s/standalone");
    expect(merged.twins.slack?.rest_url).toBe("http://127.0.0.1:3334/s/standalone");
    expect(merged.name).toBe("github");
  });

  it("starts fresh from an absent, unreadable or partly broken file", () => {
    expect(Object.keys(mergeStandaloneStatus(undefined, [entry("github", 3333)]).twins)).toEqual([
      "github",
    ]);
    expect(Object.keys(mergeStandaloneStatus("garbage", [entry("github", 3333)]).twins)).toEqual([
      "github",
    ]);
    const broken = { twins: { slack: { name: "slack" }, linear: entry("linear", 3337) } };
    expect(Object.keys(mergeStandaloneStatus(broken, [entry("github", 3333)]).twins)).toEqual([
      "linear",
      "github",
    ]);
  });

  it("standaloneStatusEntries reads both shapes", () => {
    expect(standaloneStatusEntries(entry("github", 3333)).map((e) => e.name)).toEqual(["github"]);
    const file = mergeStandaloneStatus(undefined, [entry("github", 3333), entry("slack", 3334)]);
    expect(standaloneStatusEntries(file).map((e) => e.name)).toEqual(["github", "slack"]);
    expect(standaloneStatusEntries(undefined)).toEqual([]);
    expect(standaloneStatusEntries({ hello: "world" })).toEqual([]);
  });
});

describe("updateStandaloneStatusFile", () => {
  const entry = (name: StandaloneStatus["name"], port: number): StandaloneStatus => ({
    name,
    url: `http://127.0.0.1:${port}/s/standalone`,
    rest_url: `http://127.0.0.1:${port}/s/standalone`,
    mcp_url: `http://127.0.0.1:${port}/s/standalone/mcp`,
    auth_token: `token-${name}`,
  });

  it("concurrent starts in one folder all land in the file (read-merge-write is locked)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-status-lock-"));
    const path = join(dir, ".pome", "twin-status.json");
    const names: StandaloneStatus["name"][] = ["github", "slack", "stripe", "gmail", "linear"];
    await Promise.all(names.map((name, i) => updateStandaloneStatusFile([entry(name, 3400 + i)], path)));
    const file = JSON.parse(await readFile(path, "utf8")) as { twins: Record<string, unknown> };
    expect(Object.keys(file.twins).sort()).toEqual([...names].sort());
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("makes .pome/ git-ignore itself, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-status-ignore-"));
    const path = join(dir, ".pome", "twin-status.json");
    await updateStandaloneStatusFile([entry("github", 3333)], path);
    expect(await readFile(join(dir, ".pome", ".gitignore"), "utf8")).toBe("*\n");
    // A user's own edit is kept.
    await writeFile(join(dir, ".pome", ".gitignore"), "twin-status.json\n");
    await updateStandaloneStatusFile([entry("slack", 3334)], path);
    expect(await readFile(join(dir, ".pome", ".gitignore"), "utf8")).toBe("twin-status.json\n");
  });

  it("breaks a stale lock a crashed writer left behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-status-stale-"));
    const path = join(dir, ".pome", "twin-status.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, "12345");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const merged = await updateStandaloneStatusFile([entry("github", 3333)], path);
    expect(Object.keys(merged.twins)).toEqual(["github"]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("refuses, naming the lock, when another process holds it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-status-held-"));
    const path = join(dir, ".pome", "twin-status.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, "12345"); // fresh: mtime is now
    await expect(updateStandaloneStatusFile([entry("github", 3333)], path)).rejects.toThrow(
      "is held by another pome process",
    );
  }, 15_000);
});
