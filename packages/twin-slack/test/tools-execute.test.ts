// SPDX-License-Identifier: Apache-2.0
// Every tool Slack declares and this twin serves, driven through `executeTool` with
// the arguments SLACK'S schema takes.

import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { executeTool, slackToolFixture } from "../src/tools.js";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return domain;
}

describe("executeTool", () => {
  const actor = { login: "pome-agent" };

  it("runs all 18 tools", () => {
    const domain = fresh();
    const called = new Set<string>();
    const run = (name: string, args: Record<string, unknown>) => {
      called.add(name);
      return executeTool(domain, name, args, undefined, actor);
    };

    const parent = run("slack_send_message", {
      channel_id: "C_GENERAL",
      message: "parent",
    }) as { ts: string };

    // The fold: no slack_reply_to_thread, because Slack puts the
    // reply on the send via thread_ts.
    const reply = run("slack_send_message", {
      channel_id: "C_GENERAL",
      message: "reply",
      thread_ts: parent.ts,
      reply_broadcast: false,
    }) as { message?: { thread_ts?: string } };
    expect(reply.message?.thread_ts).toBe(parent.ts);

    run("slack_schedule_message", {
      channel_id: "C_GENERAL",
      message: "later",
      post_at: Math.floor(Date.now() / 1000) + 600,
    });

    run("slack_add_reaction", {
      channel_id: "C_GENERAL",
      message_ts: parent.ts,
      emoji: "eyes",
    });

    const conversation = run("slack_create_conversation", {
      channel_name: "f1330-probe",
      user_ids: ["U_ALICE"],
    }) as { channel: { id: string } };
    expect(conversation.channel.id).toMatch(/^C/);

    const canvas = run("slack_create_canvas", {
      title: "Runbook",
      content: "# Runbook\nStep one.",
    }) as { canvas_id: string };

    run("slack_update_canvas", {
      canvas_id: canvas.canvas_id,
      sections: [
        { edit_type: "append", content: "Step two." },
        { edit_type: "append", content: "Step three." },
      ],
    });
    const read = run("slack_read_canvas", { canvas_id: canvas.canvas_id }) as {
      content: string;
      section_id_mapping: Record<string, string>;
    };
    // Both appends, not just the first — the silent drop is closed.
    expect(read.content).toContain("Step two.");
    expect(read.content).toContain("Step three.");
    expect(Object.keys(read.section_id_mapping).length).toBe(1);

    const publicSearch = run("slack_search_public", { query: "parent" }) as {
      messages: { matches: Array<{ text: string }> };
    };
    expect(publicSearch.messages.matches.some((m) => m.text === "parent")).toBe(true);

    const allSearch = run("slack_search_public_and_private", { query: "parent", limit: 5 }) as {
      messages: { matches: unknown[] };
    };
    expect(allSearch.messages.matches.length).toBeGreaterThan(0);

    // `query` is required now, and it filters — the behaviour change from
    // slack_list_channels / slack_get_users, which took none and returned all.
    const channels = run("slack_search_channels", { query: "general" }) as {
      channels: Array<{ name: string }>;
    };
    expect(channels.channels.map((c) => c.name)).toEqual(["general"]);

    const users = run("slack_search_users", { query: "alice" }) as {
      members: Array<{ name: string }>;
    };
    expect(users.members.map((m) => m.name)).toEqual(["alice"]);

    const history = run("slack_read_channel", { channel_id: "C_GENERAL", limit: 5 }) as {
      messages: unknown[];
    };
    expect(history.messages.length).toBeGreaterThan(0);

    const thread = run("slack_read_thread", {
      channel_id: "C_GENERAL",
      message_ts: parent.ts,
    }) as { messages: unknown[] };
    expect(thread.messages.length).toBeGreaterThan(1);

    const profile = run("slack_read_user_profile", { user_id: "U_ALICE" }) as {
      profile: { real_name: string };
    };
    expect(profile.profile.real_name).toBe("Alice");

    const members = run("slack_list_channel_members", { channel_id: "C_GENERAL" }) as {
      members: string[];
    };
    expect(members.members).toContain("U_ALICE");

    const file = domain.filesUpload(
      { channels: "C_GENERAL", filename: "notes.txt", content: "hello" },
      actor
    ) as { file: { id: string } };
    const readFile = run("slack_read_file", { file_id: file.file.id }) as {
      file: { name: string };
    };
    expect(readFile.file.name).toBe("notes.txt");

    const emoji = run("slack_search_emojis", { query: "pome" }) as {
      emoji: Record<string, string>;
    };
    expect(Object.keys(emoji.emoji).every((name) => name.includes("pome"))).toBe(true);

    const reactions = run("slack_get_reactions", {
      channel_id: "C_GENERAL",
      message_ts: parent.ts,
    }) as { message: { reactions: Array<{ name: string; count: number }> } };
    expect(reactions.message.reactions).toEqual([
      expect.objectContaining({ name: "eyes", count: 1 }),
    ]);

    // The set, not just the count: a tool added to the fixture without a case
    // here would otherwise pass unexercised.
    expect([...called].sort()).toEqual([...slackToolFixture.toolNames].sort());
  });

  it("refuses a create_conversation naming neither a channel nor users", () => {
    expect(() => executeTool(fresh(), "slack_create_conversation", {}, undefined, actor)).toThrow(
      /invalid_arguments/
    );
  });

  it("scopes slack_search_public to public channels and the other search to all", () => {
    const domain = fresh();
    domain.conversationsCreate({ name: "war-room", is_private: true }, actor);
    const priv = domain.allChannels().find((c) => c.name === "war-room")!;
    domain.chatPostMessage({ channel: priv.id, text: "classified needle" }, actor);

    const publicOnly = executeTool(
      domain,
      "slack_search_public",
      { query: "needle" },
      undefined,
      actor
    ) as { messages: { matches: unknown[] } };
    expect(publicOnly.messages.matches).toEqual([]);

    const everything = executeTool(
      domain,
      "slack_search_public_and_private",
      { query: "needle" },
      undefined,
      actor
    ) as { messages: { matches: unknown[] } };
    expect(everything.messages.matches.length).toBe(1);
  });

 it("accepts a live Slack argument the legacy strictObject hard-rejected", () => {
    // `response_format` is declared by Slack on five tools and modelled by
    // none of the twin's old schemas. Under z.strictObject this threw.
    const domain = fresh();
    expect(() =>
      executeTool(
        domain,
        "slack_read_channel",
        { channel_id: "C_GENERAL", limit: 5, response_format: "concise", oldest: "0" },
        undefined,
        actor
      )
    ).not.toThrow();
  });
  it("leaves archived channels out of slack_search_channels unless asked", () => {
    // Slack's flag is `include_archived` and defaults to false; the Web API's
    // is `exclude_archived`. An absent flag has to mean "exclude".
    const domain = fresh();
    domain.conversationsCreate({ name: "old-project" }, actor);
    const created = domain.allChannels().find((c) => c.name === "old-project")!;
    domain.conversationsArchive({ channel: created.id }, actor);

    const byDefault = executeTool(
      domain,
      "slack_search_channels",
      { query: "old-project" },
      undefined,
      actor
    ) as { channels: unknown[] };
    expect(byDefault.channels).toEqual([]);

    const asked = executeTool(
      domain,
      "slack_search_channels",
      { query: "old-project", include_archived: true },
      undefined,
      actor
    ) as { channels: Array<{ name: string }> };
    expect(asked.channels.map((c) => c.name)).toEqual(["old-project"]);
  });
});
