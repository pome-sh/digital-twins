// SPDX-License-Identifier: Apache-2.0
//
// MCP tools contract — pins the 11 visible Slack-agent tools' shapes so any
// drift (added/removed/renamed tool, changed description, changed required
// fields, changed mutating set) breaks this test loudly. Constants are
// declared in-test so the contract has no external dependency.

import { describe, expect, it } from "vitest";
import {
  MUTATING_TOOL_NAMES,
  slackToolFixture,
  slackToolInputSchema,
  toolSchemas,
} from "../src/tools.js";

interface ExpectedTool {
  name: string;
  description: string;
  required: string[];
  readOnly: boolean;
}

const EXPECTED_TOOLS: ExpectedTool[] = [
  {
    name: "slack_post_message",
    description: "Post a new message to a Slack channel",
    required: ["channel_id", "text"],
    readOnly: false,
  },
  {
    name: "slack_reply_to_thread",
    description: "Reply to a specific message thread in Slack",
    required: ["channel_id", "thread_ts", "text"],
    readOnly: false,
  },
  {
    name: "slack_add_reaction",
    description: "Add a reaction emoji to a message",
    required: ["channel_id", "timestamp", "reaction"],
    readOnly: false,
  },
  {
    name: "slack_get_channel_history",
    description: "Get recent messages from a channel",
    required: ["channel_id"],
    readOnly: true,
  },
  {
    name: "slack_get_thread_replies",
    description: "Get all replies in a message thread",
    required: ["channel_id", "thread_ts"],
    readOnly: true,
  },
  {
    name: "slack_list_channels",
    description: "List public or pre-defined channels in the workspace with pagination",
    required: [],
    readOnly: true,
  },
  {
    name: "slack_get_users",
    description: "Get a list of all users in the workspace with their basic profile information",
    required: [],
    readOnly: true,
  },
  {
    name: "slack_get_user_profile",
    description: "Get detailed profile information for a specific user",
    required: ["user_id"],
    readOnly: true,
  },
  {
    name: "slack_search_messages",
    description: "Search messages in the workspace by text query",
    required: ["query"],
    readOnly: true,
  },
  {
    name: "slack_get_reactions",
    description: "Get all reactions on a specific message",
    required: ["channel_id", "timestamp"],
    readOnly: true,
  },
  {
    name: "slack_list_channel_members",
    description: "List the member user IDs of a channel with pagination",
    required: ["channel_id"],
    readOnly: true,
  },
];

const EXPECTED_NAMES = EXPECTED_TOOLS.map((t) => t.name).sort();
const EXPECTED_MUTATORS = new Set(EXPECTED_TOOLS.filter((t) => !t.readOnly).map((t) => t.name));

describe("MCP tools contract", () => {
  it("exposes exactly the 11 visible Slack-agent tools", () => {
    expect([...slackToolFixture.toolNames].sort()).toEqual(EXPECTED_NAMES);
    expect(EXPECTED_TOOLS.length).toBe(11);
  });

  it("MUTATING_TOOL_NAMES contains the 3 write tools (no readOnlyHint)", () => {
    expect(EXPECTED_MUTATORS.size).toBe(3);
    expect(MUTATING_TOOL_NAMES).toEqual(EXPECTED_MUTATORS);
  });

  it("each visible tool emits additionalProperties:false JSON-Schema", () => {
    for (const tool of slackToolFixture.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("tool descriptions are pinned exactly", () => {
    const byName = new Map(EXPECTED_TOOLS.map((t) => [t.name, t]));
    for (const tool of slackToolFixture.tools) {
      const expected = byName.get(tool.name);
      expect(expected, `tool ${tool.name} missing from EXPECTED_TOOLS`).toBeDefined();
      expect(tool.description).toBe(expected!.description);
    }
  });

  it("tool required-fields match the pinned set exactly", () => {
    const byName = new Map(EXPECTED_TOOLS.map((t) => [t.name, t]));
    for (const tool of slackToolFixture.tools) {
      const expected = byName.get(tool.name)!;
      const actualRequired = [...(tool.inputSchema.required as string[])].sort();
      const expectedRequired = [...expected.required].sort();
      expect(actualRequired).toEqual(expectedRequired);
    }
  });

  // F-1325 — the fixture carries the inputSchema the wire serves, and the zod
  // schemas below it are what `tools/call` validates against. Nothing keeps
  // the two together except this: run the frozen draft-7 projection over every
  // declared schema and demand the fixture's bytes back.
  it("every declared schema projects to exactly the inputSchema the fixture serves", () => {
    expect(Object.keys(toolSchemas).sort()).toEqual([...slackToolFixture.toolNames].sort());
    for (const tool of slackToolFixture.tools) {
      const projected = slackToolInputSchema(toolSchemas[tool.name as keyof typeof toolSchemas]);
      expect(projected, tool.name).toEqual(tool.inputSchema);
    }
  });

  it("the fixture serves camelCase inputSchema (MCP spec)", () => {
    expect(slackToolFixture.tools.length).toBe(11);
    expect(slackToolFixture.tools[0]).toHaveProperty("inputSchema");
  });

  it("readOnlyHint is present on read tools, absent on mutators", () => {
    const tools = slackToolFixture.tools;
    const mutators = tools.filter((t) => !("annotations" in t));
    const readers = tools.filter((t) => t.annotations?.readOnlyHint === true);
    expect(mutators.length).toBe(3);
    expect(readers.length).toBe(8);
  });
});
