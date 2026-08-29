// SPDX-License-Identifier: Apache-2.0
//
// A misspelled seed field, seen the only way it CAN be seen: by reading the
// field back off the twin's own surface.
//
// This defect is invisible to a test that only parses. Both the good seed and
// the typo'd one parsed clean and both booted; the difference showed up nowhere
// except in what `GET /repos/:o/:r/issues` answered. So each case below plants a
// field, then asks the route that serves it what it got.
//
//   seed { repositories: [{ owner, name, issues:  [ … ] }] }  → GET …/issues → [the issue]
//   seed { repositories: [{ owner, name, isuses:  [ … ] }] }  → GET …/issues → []      ← the defect
//
// The author asked for a world with an issue in it, got a world with no issue,
// a green boot, and nothing anywhere saying so. Under a strict schema the second
// row stops existing: there is no booted world to ask, because the parse refused
// and named the key.
//
// The four doors are the same function — `parseSeed` — reached four ways:
// `createGitHubCloneApp({ seed })` at boot, `loadSeedFromEnv` from
// `POME_SEED_JSON`, `POST /admin/seed` on a live twin, and the CLI's
// `--seed <file>`. Three of them are exercised here; the fourth is
// `cli/test/unit/twin/seedFile.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { loadSeedFromEnv, parseSeed } from "../src/seed.js";
import type { GitHubStateSeed } from "../src/types.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

/** The world the author meant to write. */
const SPELLED_RIGHT = {
  users: [{ login: "zed", type: "Organization", name: "Zed" }],
  repositories: [
    {
      owner: "zed",
      name: "quiet",
      issues: [{ number: 1, title: "silently dropped" }],
    },
  ],
} as unknown as GitHubStateSeed;

async function get(app: ReturnType<typeof createGitHubCloneApp>, path: string) {
  const response = await app.request(`${base}${path}`, withAuth(token));
  return { status: response.status, body: await response.json() };
}

describe("the field the author spelled right reads back", () => {
  it("serves the seeded issue at GET /repos/:o/:r/issues", async () => {
    const app = createGitHubCloneApp({ seed: parseSeed(SPELLED_RIGHT) as GitHubStateSeed });
    const { status, body } = await get(app, "/repos/zed/quiet/issues");
    expect(status).toBe(200);
    expect((body as Array<{ title: string }>).map((issue) => issue.title)).toEqual([
      "silently dropped",
    ]);
  });
});

// Each row is a real field, misspelled the way a human misspells it, at a
// different depth — because strictness on the root object alone would pass a
// top-level case and still drop everything nested.
const TYPOS: Array<{ where: string; key: string; seed: unknown }> = [
  {
    where: "the root",
    key: "repositores",
    seed: { repositores: [{ owner: "zed", name: "quiet" }], repositories: [{ owner: "zed", name: "quiet" }] },
  },
  {
    where: "a repository",
    key: "isuses",
    seed: { repositories: [{ owner: "zed", name: "quiet", isuses: [{ title: "dropped" }] }] },
  },
  {
    where: "an issue",
    key: "asignees",
    seed: {
      repositories: [
        { owner: "zed", name: "quiet", issues: [{ title: "t", asignees: ["zed"] }] },
      ],
    },
  },
  {
    where: "a pull request",
    key: "reviws",
    seed: {
      repositories: [
        {
          owner: "zed",
          name: "quiet",
          pull_requests: [{ title: "t", head: "feature", reviws: [] }],
        },
      ],
    },
  },
  {
    where: "a file",
    key: "contents",
    seed: {
      repositories: [
        { owner: "zed", name: "quiet", files: [{ path: "a.txt", contents: "x" }] },
      ],
    },
  },
  {
    where: "a review",
    key: "athor",
    seed: {
      repositories: [
        {
          owner: "zed",
          name: "quiet",
          pull_requests: [
            { title: "t", head: "feature", reviews: [{ author: "zed", athor: "zed" }] },
          ],
        },
      ],
    },
  },
];

describe("a key no seed field matches is refused, naming the key", () => {
  it.each(TYPOS)("$where: $key", ({ key, seed }) => {
    expect(() => parseSeed(seed)).toThrow(new RegExp(key));
  });

  // The boot door. Before this, the app booted and answered `[]`.
  it("refuses at boot rather than serving an empty world", () => {
    const typod = {
      repositories: [{ owner: "zed", name: "quiet", isuses: [{ number: 1, title: "dropped" }] }],
    };
    expect(() => createGitHubCloneApp({ seed: parseSeed(typod) as GitHubStateSeed })).toThrow(
      /isuses/,
    );
  });

  // The env door the pod boots through, which is what a hosted `POST /v1/sessions`
  // becomes. `loadSeedFromEnv` already threw on malformed JSON; a well-formed
  // typo was the case it could not see.
  it("refuses from POME_SEED_JSON", () => {
    expect(() =>
      loadSeedFromEnv({
        POME_SEED_JSON: JSON.stringify({
          repositories: [{ owner: "zed", name: "quiet", isuses: [] }],
        }),
      }),
    ).toThrow(/isuses/);
  });
});

// `pome compile-seeds` stamps this block on every `<task>.seed.json`, and in the
// envelope sidecars it sits INSIDE the twin's arm, where no top-level strip
// reaches it. It is dropped by the twin's own door so all four channels agree.
describe("the `_meta` provenance block is not a typo", () => {
  it("is accepted and does not reach the parsed seed", () => {
    const parsed = parseSeed({
      _meta: { version: 1, source_hash: "sha256:hand-authored", model: "hand-authored" },
      repositories: [{ owner: "zed", name: "quiet" }],
    }) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("_meta");
    expect((parsed.repositories as unknown[]).length).toBe(1);
  });
});
