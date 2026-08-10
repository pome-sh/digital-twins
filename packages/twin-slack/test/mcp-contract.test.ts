// SPDX-License-Identifier: Apache-2.0
//
// MCP tools contract — pins the 18 tools this twin serves so any drift
// (added/removed/renamed tool, changed required fields, changed mutating set)
// breaks this test loudly.
//
// The expectations below are SLACK'S, read off F-1329's live OAuth capture and
// written out by hand here so the contract has no external dependency. That is
// the whole difference F-1330 made: this file used to pin eleven names copied
// out of an archived reference server, and it was green the entire time the
// twin served a tool surface no Slack deployment has.

import { describe, expect, it } from "vitest";
import { MUTATING_TOOL_NAMES, slackToolFixture, toolSchemas } from "../src/tools.js";
import { toolSchemaConformance } from "../src/tool-schema-conformance.js";

interface ExpectedTool {
  name: string;
  required: string[];
  readOnly: boolean;
}

/** The listing order is Slack's, and the fixture preserves it. */
const EXPECTED_TOOLS: ExpectedTool[] = [
  { name: "slack_send_message", required: ["channel_id", "message"], readOnly: false },
  {
    name: "slack_schedule_message",
    required: ["channel_id", "message", "post_at"],
    readOnly: false,
  },
  { name: "slack_add_reaction", required: ["channel_id", "message_ts", "emoji"], readOnly: false },
  { name: "slack_create_conversation", required: [], readOnly: false },
  { name: "slack_create_canvas", required: ["title", "content"], readOnly: false },
  { name: "slack_update_canvas", required: ["canvas_id"], readOnly: false },
  { name: "slack_search_public", required: ["query"], readOnly: true },
  { name: "slack_search_public_and_private", required: ["query"], readOnly: true },
  { name: "slack_search_channels", required: ["query"], readOnly: true },
  { name: "slack_search_users", required: ["query"], readOnly: true },
  { name: "slack_read_channel", required: ["channel_id"], readOnly: true },
  { name: "slack_read_thread", required: ["channel_id", "message_ts"], readOnly: true },
  { name: "slack_read_canvas", required: ["canvas_id"], readOnly: true },
  { name: "slack_read_user_profile", required: [], readOnly: true },
  { name: "slack_list_channel_members", required: ["channel_id"], readOnly: true },
  { name: "slack_read_file", required: ["file_id"], readOnly: true },
  { name: "slack_search_emojis", required: ["query"], readOnly: true },
  { name: "slack_get_reactions", required: ["channel_id", "message_ts"], readOnly: true },
];

/**
 * Names the twin served before F-1330 that Slack has never declared. Kept as a
 * standing assertion rather than deleted with the code: the failure mode this
 * ticket fixed was a plausible-sounding name nobody checked, and the cheapest
 * guard against its return is to say out loud that these eight are not Slack's.
 */
const FABRICATED_NAMES = [
  "slack_post_message",
  "slack_reply_to_thread",
  "slack_get_channel_history",
  "slack_get_thread_replies",
  "slack_get_user_profile",
  "slack_get_users",
  "slack_list_channels",
  "slack_search_messages",
];

const EXPECTED_NAMES = EXPECTED_TOOLS.map((t) => t.name).sort();
const EXPECTED_MUTATORS = new Set(EXPECTED_TOOLS.filter((t) => !t.readOnly).map((t) => t.name));

describe("MCP tools contract", () => {
  it("exposes exactly the 18 tools Slack declares and this twin exposes", () => {
    expect([...slackToolFixture.toolNames].sort()).toEqual(EXPECTED_NAMES);
    expect(EXPECTED_TOOLS.length).toBe(18);
  });

  it("serves the listing in Slack's own order", () => {
    expect([...slackToolFixture.toolNames]).toEqual(EXPECTED_TOOLS.map((t) => t.name));
  });

  it("serves none of the eight names commit 6abec3c invented", () => {
    for (const name of FABRICATED_NAMES) {
      expect(slackToolFixture.toolNames, `${name} is not a Slack tool`).not.toContain(name);
      expect(Object.keys(toolSchemas)).not.toContain(name);
    }
  });

  it("does not serve slack_send_message_draft, the one tool Slack declares and this twin does not", () => {
    // Ruled cold in F-1330's gate 1; registered in pome-cloud's
    // known-divergences/slack.mcp.yaml, reasoned in
    // docs/slack-mcp-unexposed-tools.md. The absence is a decision, so it is
    // asserted rather than merely true.
    expect(slackToolFixture.toolNames).not.toContain("slack_send_message_draft");
    expect(slackToolFixture.meta.configuration?.unexposed).toMatch(/slack_send_message_draft/);
  });

  it("MUTATING_TOOL_NAMES contains the 6 write tools", () => {
    expect(EXPECTED_MUTATORS.size).toBe(6);
    expect(MUTATING_TOOL_NAMES).toEqual(EXPECTED_MUTATORS);
  });

  it("derives the mutating set from Slack's own readOnlyHint", () => {
    // Recorder truth for `state_mutation` is this twin's to declare, but it
    // has no business disagreeing with the vendor about which calls write.
    const upstreamWrites = new Set(
      slackToolFixture.tools
        .filter((tool) => (tool.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === false)
        .map((tool) => tool.name)
    );
    expect(MUTATING_TOOL_NAMES).toEqual(upstreamWrites);
  });

  it("declares no additionalProperties, because Slack declares none", () => {
    // The reversal F-1330 landed. Every one of these carried
    // `additionalProperties:false` before, so a correctly-named call carrying
    // a real Slack parameter was hard-rejected.
    for (const tool of slackToolFixture.tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBeUndefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("tool required-fields match the pinned set exactly", () => {
    const byName = new Map(EXPECTED_TOOLS.map((t) => [t.name, t]));
    for (const tool of slackToolFixture.tools) {
      const expected = byName.get(tool.name)!;
      const actualRequired = [...((tool.inputSchema.required as string[] | undefined) ?? [])].sort();
      expect(actualRequired, tool.name).toEqual([...expected.required].sort());
    }
  });

  // F-1330 — the fixture carries the inputSchema the wire serves, and the zod
  // schemas are what `tools/call` validates against. Byte equality between the
  // two stopped being possible when the fixture became Slack's (its schemas
  // carry prose no zod schema projects to), so the pin is the argument surface:
  // same keys, same required set, and no rejection of an unknown key.
  it("validates exactly the argument surface Slack declares", () => {
    expect(toolSchemaConformance()).toEqual([]);
  });

  it("the fixture serves camelCase inputSchema (MCP spec)", () => {
    expect(slackToolFixture.tools.length).toBe(18);
    expect(slackToolFixture.tools[0]).toHaveProperty("inputSchema");
  });

  it("readOnlyHint is present on read tools and false on mutators", () => {
    const tools = slackToolFixture.tools;
    const mutators = tools.filter(
      (t) => (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === false
    );
    const readers = tools.filter(
      (t) => (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true
    );
    expect(mutators.length).toBe(6);
    expect(readers.length).toBe(12);
  });
});
