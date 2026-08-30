// SPDX-License-Identifier: Apache-2.0
// `pome sandbox create --seed <path>` — the hosted half of the seed door.
//
// One seed file, three doors. This asserts the part that is this command's own
// business: which twins the session gets, and WHICH SHAPE reaches the wire.
//
// THE RULE does not move (`cli/src/contract/seed-envelope.ts`): the create-session
// `seed` is a per-twin envelope iff the session has more than one twin, decided
// from `twins` alone. So a one-twin session sends the FLAT seed even when the
// file the user wrote was an envelope, and the CLI unwraps rather than forwards.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionResponse } from "../../src/types/shared.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveCredentials: vi.fn(),
}));

vi.mock("../../src/cli/credentials.js", () => ({
  resolveCredentials: mocks.resolveCredentials,
}));

vi.mock("../../src/cli/agent-identity.js", () => ({
  resolveRunAgentIdentity: vi.fn(async () => ({})),
}));

vi.mock("../../src/hosted/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hosted/client.js")>();
  return {
    ...actual,
    createHostedClient: vi.fn(() => ({ createSession: mocks.createSession })),
  };
});

import { runSessionCreate } from "../../src/cli/session.js";

const response: CreateSessionResponse = {
  session_id: "ses_test",
  session_token: "ses_test",
  twin_url: "https://twin.example.com/s/ses_test",
  expires_at: "2026-06-24T16:30:00.000Z",
  openapi_url: "https://twin.example.com/s/ses_test/openapi.json",
  agent_token: "agent_secret_token",
  per_twin: {},
  provider_credentials: {},
};

const GITHUB_SEED = {
  users: [{ login: "vakoi", type: "Organization", name: "Vakoi" }],
  repositories: [{ owner: "vakoi", name: "billing" }],
};
const SLACK_SEED = { channels: [{ id: "C_ENG", name: "eng-alerts" }] };

async function seedFile(value: unknown, name = "seed.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-sandbox-seed-"));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

/** The `seed` this invocation actually put on the wire. */
function sentSeed(): unknown {
  return mocks.createSession.mock.calls.at(-1)?.[0]?.seed;
}
function sentTwins(): string[] {
  return mocks.createSession.mock.calls.at(-1)?.[0]?.twins as string[];
}

describe("pome sandbox create --seed", () => {
  beforeEach(() => {
    mocks.resolveCredentials.mockResolvedValue({
      apiBaseUrl: "https://api.example.com",
      apiKey: "control_plane_secret",
    });
    mocks.createSession.mockResolvedValue(response);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.createSession.mockReset();
    mocks.resolveCredentials.mockReset();
  });

  it("sends no `seed` at all when --seed is omitted", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      json: false,
    });
    expect(sentSeed()).toBeUndefined();
  });

  it("unwraps a one-twin envelope to the FLAT wire shape", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      json: false,
      seedPath: await seedFile({ github: GITHUB_SEED }),
    });
    expect(sentTwins()).toEqual(["github"]);
    expect(sentSeed()).toMatchObject({
      repositories: [expect.objectContaining({ owner: "vakoi", name: "billing" })],
    });
    expect(sentSeed()).not.toHaveProperty("github");
  });

  it("still takes the flat file shape F-1686 shipped", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      json: false,
      seedPath: await seedFile(GITHUB_SEED),
    });
    expect(sentSeed()).toMatchObject({ repositories: [expect.objectContaining({ name: "billing" })] });
  });

  it("sends the ENVELOPE when the session has more than one twin", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github", "slack"],
      json: false,
      seedPath: await seedFile({ github: GITHUB_SEED, slack: SLACK_SEED }),
    });
    expect(sentTwins()).toEqual(["github", "slack"]);
    const seed = sentSeed() as Record<string, { channels?: unknown[] }>;
    expect(Object.keys(seed).sort()).toEqual(["github", "slack"]);
    expect(seed.slack?.channels).toHaveLength(1);
  });

  it("an envelope naming exactly one twin makes --twin unnecessary", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: [],
      json: false,
      seedPath: await seedFile({ linear: {} }),
    });
    expect(sentTwins()).toEqual(["linear"]);
  });

  it("refuses BY NAME a file naming a twin the sandbox was not asked for", async () => {
    await expect(
      runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["github"],
        json: false,
        seedPath: await seedFile({ github: GITHUB_SEED, slack: SLACK_SEED }),
      }),
    ).rejects.toThrow(/names slack, which this command was not asked for/);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("refuses a flat file when the sandbox has more than one twin — it names no twin", async () => {
    await expect(
      runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["github", "slack"],
        json: false,
        seedPath: await seedFile(GITHUB_SEED),
      }),
    ).rejects.toThrow(/is a flat seed and this sandbox has 2 twins/);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  // `pome twin new-seed <twin>` writes a FLAT file, so this is the path a reader
  // who copied the README takes. The generic "No twin specified" never mentioned
  // the seed, which reads as if `--twin` had simply been forgotten — so the
  // message says the file is flat and spells the fix out (F-1762).
  it("still needs --twin when the file is flat, and says so naming the seed", async () => {
    await expect(
      runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: [],
        json: false,
        seedPath: await seedFile(GITHUB_SEED),
      }),
    ).rejects.toThrow(
      /is a flat seed, so it does not name a twin\. Pass the name: pome sandbox create --twin </,
    );
  });

  // F-1688: a seed the pod refuses reports as `503 Failed to spawn twin pod`
  // twelve seconds later. The same `parseSeed` the pod runs is right here, so
  // the refusal is instant and names the field — no round trip, no session.
  it("refuses a schema-invalid seed before the round trip, naming the twin's own field", async () => {
    await expect(
      runSessionCreate({
        apiBaseUrl: "https://api.example.com",
        twins: ["github"],
        json: false,
        seedPath: await seedFile({ github: { repositories: [{ owner: "acme" }] } }),
      }),
    ).rejects.toThrow(/is not a seed this twin can boot[\s\S]*name/);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("drops the `_meta` block, so a compiled sidecar is a hosted seed file too", async () => {
    await runSessionCreate({
      apiBaseUrl: "https://api.example.com",
      twins: ["github"],
      json: false,
      seedPath: await seedFile({ _meta: { source_hash: "sha256:abc" }, ...GITHUB_SEED }),
    });
    expect(sentSeed()).not.toHaveProperty("_meta");
  });
});
