// SPDX-License-Identifier: Apache-2.0
//
// The CLI's half of F-1689: what `pome twin start --seed` and
// `pome sandbox create --seed` say when the file the reader wrote has a key no
// seed field matches.
//
// `seedFile.ts` is deliberately NOT a second seed parser — it decides which
// bytes belong to which twin and hands them to that twin's own `parseSeed`. So
// what is under test here is that the twin's refusal SURVIVES the trip: it
// reaches the reader with the misspelled key in it, wrapped in the message that
// names their file.
//
// The `_meta` cases are the other half. Every `<task>.seed.json` in the library
// carries a provenance block, and in the envelope sidecars it sits INSIDE the
// twin's own arm (`{ github: { _meta, … } }`) where this module's top-level strip
// cannot reach it. Pointing `--seed` at one of those files is the documented
// workflow, so both placements must boot.

import { describe, expect, it } from "vitest";
import { parseSeedFileText, seedForTwin, seedsForTwins } from "../../../src/twin/seedFile.js";

const ORIGIN = "--seed w.json";

describe("a key no seed field matches reaches the reader by name", () => {
  it("github: a misspelled repository field", async () => {
    const file = parseSeedFileText(
      JSON.stringify({
        repositories: [{ owner: "zed", name: "quiet", isuses: [{ title: "dropped" }] }],
      }),
      ORIGIN,
    );
    await expect(seedForTwin(file, "github", ORIGIN)).rejects.toThrow(/isuses/);
  });

  it("slack: a misspelled channel field, inside an envelope", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ slack: { channels: [{ name: "eng-alerts", mesages: [] }] } }),
      ORIGIN,
    );
    await expect(seedForTwin(file, "slack", ORIGIN)).rejects.toThrow(/mesages/);
  });

  it("stripe: a misspelled charge field", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ stripe: { charges: [{ id: "ch_1", amount_refunfed: 1 }] } }),
      ORIGIN,
    );
    await expect(seedForTwin(file, "stripe", ORIGIN)).rejects.toThrow(/amount_refunfed/);
  });

  it("still says which file and which twin", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ repositories: [{ owner: "zed", name: "quiet", isuses: [] }] }),
      ORIGIN,
    );
    await expect(seedForTwin(file, "github", ORIGIN)).rejects.toThrow(
      /--seed w\.json is not a seed this twin can boot/,
    );
  });
});

// Every compiled sidecar in `cli/tasks/` and `agent-examples/` carries `_meta`,
// twelve of them inside the twin's arm rather than at the top. Under strict
// schemas an unhandled provenance block is a refusal of the whole library.
describe("the `_meta` provenance block boots at either placement", () => {
  const META = { version: 1, source_hash: "sha256:hand-authored", model: "hand-authored" };

  it("at the top of a flat file", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ _meta: META, repositories: [{ owner: "zed", name: "quiet" }] }),
      ORIGIN,
    );
    const seed = (await seedForTwin(file, "github", ORIGIN)) as { repositories: unknown[] };
    expect(seed.repositories).toHaveLength(1);
  });

  it("inside a twin's arm of an envelope — where the top-level strip cannot reach", async () => {
    const file = parseSeedFileText(
      JSON.stringify({
        github: { _meta: META, repositories: [{ owner: "zed", name: "quiet" }] },
        slack: { _meta: META, channels: [{ name: "eng-alerts" }] },
      }),
      ORIGIN,
    );
    const seeds = (await seedsForTwins(file, ["github", "slack"], ORIGIN)) as {
      github: { repositories: unknown[] };
      slack: { channels: unknown[] };
    };
    expect(seeds.github.repositories).toHaveLength(1);
    expect(seeds.slack.channels).toHaveLength(1);
  });

  it("on gmail and linear too, whose schemas were strict before this", async () => {
    const file = parseSeedFileText(
      JSON.stringify({
        gmail: { _meta: META, primaryMailbox: { email: "ops@vakoi.test" } },
        linear: { _meta: META, teams: [{ key: "ENG", name: "Engineering" }] },
      }),
      ORIGIN,
    );
    const seeds = (await seedsForTwins(file, ["gmail", "linear"], ORIGIN)) as {
      gmail: { primaryMailbox: { email: string } };
      linear: { teams: unknown[] };
    };
    expect(seeds.gmail.primaryMailbox.email).toBe("ops@vakoi.test");
    expect(seeds.linear.teams).toHaveLength(1);
  });
});
