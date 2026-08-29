// SPDX-License-Identifier: Apache-2.0
//
// Every top-level field the slack seed models READS BACK through the twin's own
// HTTP surface. One case per field, none of them empty.
//
// F-584's second "done when" clause, and the reason it is worth a file: the
// task-side schema modelled each of these as `z.array(z.record(…))`, an open map
// validating nothing, so what an author wrote and what the world served could
// differ with nobody noticing. `emoji` is the field that had actually been
// unreachable — the task parser refused it for two releases (#488) even though
// the twin has served it since #190.
//
// Read back over the wire, not out of `SlackDomain`: the claim is "the world the
// author wrote is the world the agent finds", and the agent finds it at
// `/api/*`.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { parseSeed } from "../src/seed.js";
import { createSlackTwinApp } from "../src/twin.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";

/** One value per seed field, each distinguishable from the twin's default, so a
 *  dropped field reads as the default rather than as the author's value. */
const WORLD = {
  team: { id: "T_VAKOI", name: "Vakoi Systems", domain: "vakoi" },
  users: [
    {
      id: "U_ALICE",
      name: "alice",
      real_name: "Alice Ferrer",
      email: "alice@vakoi.test",
      is_admin: true,
      tz: "Europe/Lisbon",
      profile: { title: "SRE" },
    },
    { id: "B_DUNNING", name: "dunning-bot", real_name: "Dunning Bot", is_bot: true },
    // The bearer this test signs. A private channel refuses `not_in_channel` to
    // a non-member, the way real Slack does, so the agent under test has to be
    // seeded INTO the channel it is expected to read.
    { id: "U_AGENT", name: "pome-agent", real_name: "Pome Agent" },
  ],
  channels: [
    {
      id: "C_ENG_ALERTS",
      name: "eng-alerts",
      is_private: true,
      topic: "Paging and incident chatter",
      purpose: "Where the on-call reads first",
      creator: "alice",
      members: ["alice", "dunning-bot", "pome-agent"],
      messages: [
        {
          user: "alice",
          text: "dunning retries fired twice on a 429",
          reactions: [{ name: "eyes", user: "dunning-bot" }],
        },
      ],
    },
  ],
  files: [
    {
      id: "F_RUNBOOK",
      name: "runbook.md",
      title: "Dunning runbook",
      filetype: "markdown",
      user: "alice",
      channels: ["eng-alerts"],
      content: "# Runbook\n1. Page the on-call.\n",
    },
  ],
  emoji: [
    { name: "shipit", alias: "squirrel" },
    { name: "vakoi", url: "https://emoji.vakoi.test/vakoi.png" },
  ],
};

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

let token: string;
let app: ReturnType<typeof createSlackTwinApp>;

beforeEach(async () => {
  token = await signTestToken();
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(parseSeed(WORLD));
  app = createSlackTwinApp({ db, domain, recorder: createRecorderStore(), runId: "test" });
});

async function api(method: string, path: string): Promise<Record<string, any>> {
  const response = await app.request(`/s/${TEST_SID}${path}`, withAuth(token, { method }));
  return (await response.json()) as Record<string, any>;
}

describe("every slack seed field reads back over the wire", () => {
  it("team — team.info", async () => {
    const body = await api("GET", "/team.info");
    expect(body.ok).toBe(true);
    expect(body.team.name).toBe("Vakoi Systems");
    expect(body.team.domain).toBe("vakoi");
  });

  it("users — users.list, with profile and tz", async () => {
    const body = await api("GET", "/users.list");
    expect(body.ok).toBe(true);
    const alice = (body.members as Array<Record<string, any>>).find((m) => m.name === "alice")!;
    expect(alice.real_name).toBe("Alice Ferrer");
    expect(alice.is_admin).toBe(true);
    expect(alice.tz).toBe("Europe/Lisbon");
    expect(alice.profile.title).toBe("SRE");
    const bot = (body.members as Array<Record<string, any>>).find((m) => m.name === "dunning-bot")!;
    expect(bot.is_bot).toBe(true);
  });

  it("channels — conversations.list keeps privacy, topic and purpose", async () => {
    const body = await api("GET", "/conversations.list?types=public_channel,private_channel");
    expect(body.ok).toBe(true);
    const channel = (body.channels as Array<Record<string, any>>).find(
      (c) => c.name === "eng-alerts",
    )!;
    expect(channel.is_private).toBe(true);
    expect(channel.topic.value).toBe("Paging and incident chatter");
    expect(channel.purpose.value).toBe("Where the on-call reads first");
  });

  it("channels[].members — conversations.members has both", async () => {
    const body = await api("GET", "/conversations.members?channel=C_ENG_ALERTS");
    expect(body.ok).toBe(true);
    expect((body.members as string[]).sort()).toEqual(["B_DUNNING", "U_AGENT", "U_ALICE"]);
  });

  it("channels[].messages and their reactions — conversations.history", async () => {
    const body = await api("GET", "/conversations.history?channel=C_ENG_ALERTS");
    expect(body.ok).toBe(true);
    const message = (body.messages as Array<Record<string, any>>)[0]!;
    expect(message.text).toBe("dunning retries fired twice on a 429");
    expect(message.user).toBe("U_ALICE");
    expect(message.reactions[0].name).toBe("eyes");
    expect(message.reactions[0].users).toContain("B_DUNNING");
  });

  it("files — files.list, with the title and filetype the author wrote", async () => {
    const body = await api("GET", "/files.list");
    expect(body.ok).toBe(true);
    const file = (body.files as Array<Record<string, any>>)[0]!;
    expect(file.id).toBe("F_RUNBOOK");
    expect(file.title).toBe("Dunning runbook");
    expect(file.filetype).toBe("markdown");
  });

  // The field the task parser refused for two releases while the twin served it.
  it("emoji — emoji.list, alias and url both", async () => {
    const body = await api("GET", "/emoji.list");
    expect(body.ok).toBe(true);
    expect(body.emoji.shipit).toBe("alias:squirrel");
    expect(body.emoji.vakoi).toBe("https://emoji.vakoi.test/vakoi.png");
  });
});
