// SPDX-License-Identifier: Apache-2.0
//
// A misspelled seed field, read back off the twin's own surface.
//
// `z.object()` strips a key it does not recognise, so `chanels` was not an
// error — it was an absence, and the only place the absence showed was in what
// `conversations.list` answered. Measured 2026-08-29:
//
//   seed { channels: [ … ] } → conversations.list → [the channel]
//   seed { chanels:  [ … ] } → conversations.list → []            ← the defect
//
// This is the same silence `seedFile.ts`'s header already names for the envelope
// case: slack ACCEPTED a `{github, slack}` file as its own flat seed, defaulted
// every field and served an empty workspace while the boot line said the seed
// had landed. That door was closed by declaring the envelope; this closes the
// schema underneath it.

import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { loadSeedFromEnv, parseSeed } from "../src/seed.js";
import type { SlackStateSeed } from "../src/types.js";

function seeded(seed: SlackStateSeed): SlackDomain {
  const domain = new SlackDomain(openSlackTwinDatabase(":memory:"));
  domain.seed(seed);
  return domain;
}

describe("the field the author spelled right reads back", () => {
  it("serves the seeded channel from conversations.list", () => {
    const domain = seeded(
      parseSeed({ channels: [{ name: "eng-alerts", topic: "pages" }] }) as SlackStateSeed,
    );
    const listed = domain.conversationsList({}) as { channels: Array<{ name: string }> };
    expect(listed.channels.map((channel) => channel.name)).toContain("eng-alerts");
  });
});

const TYPOS: Array<{ where: string; key: string; seed: unknown }> = [
  { where: "the root", key: "chanels", seed: { chanels: [{ name: "eng-alerts" }] } },
  {
    where: "a channel",
    key: "mesages",
    seed: { channels: [{ name: "eng-alerts", mesages: [] }] },
  },
  {
    where: "a message",
    key: "tread_ts",
    seed: {
      channels: [
        { name: "eng-alerts", messages: [{ user: "alice", text: "hi", tread_ts: "1.0" }] },
      ],
    },
  },
  { where: "a user", key: "real_nane", seed: { users: [{ name: "alice", real_nane: "Alice" }] } },
  {
    where: "the team",
    key: "domian",
    seed: { team: { name: "Vakoi", domian: "vakoi" } },
  },
  { where: "a file", key: "filetipe", seed: { files: [{ name: "runbook.md", filetipe: "md" }] } },
  { where: "an emoji", key: "alais", seed: { emoji: [{ name: "shipit", alais: "ship" }] } },
];

describe("a key no seed field matches is refused, naming the key", () => {
  it.each(TYPOS)("$where: $key", ({ key, seed }) => {
    expect(() => parseSeed(seed)).toThrow(new RegExp(key));
  });

  it("refuses from POME_SEED_JSON rather than booting an empty workspace", () => {
    expect(() =>
      loadSeedFromEnv({ POME_SEED_JSON: JSON.stringify({ chanels: [{ name: "eng-alerts" }] }) }),
    ).toThrow(/chanels/);
  });
});

describe("the `_meta` provenance block is not a typo", () => {
  it("is accepted and does not reach the parsed seed", () => {
    const parsed = parseSeed({
      _meta: { version: 1, source_hash: "sha256:hand-authored", model: "hand-authored" },
      channels: [{ name: "eng-alerts" }],
    }) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("_meta");
    expect((parsed.channels as unknown[]).length).toBe(1);
  });
});
