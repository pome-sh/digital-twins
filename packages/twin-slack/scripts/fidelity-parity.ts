// SPDX-License-Identifier: Apache-2.0
//
// fidelity:parity — declarative parity scenario for twin-slack.
// The runner lives in @pome-sh/sdk/parity; this file is scenario data only:
// an ordered, stateful chain (post → thread → reaction → reads) that
// exercises every MCP tool in fidelity.inventory.json against the seeded
// workspace, plus the loud-501 probe for an unsupported Web API method.
//
// Slack answers HTTP 200 with `{ok:false, error}` on API errors, so every
// step also asserts the Slack envelope's own ok flag.

import { join } from "node:path";
import { loadFidelityInventory, runParityCli, type ParityStep } from "@pome-sh/sdk/parity";
import { defaultSeedState } from "../src/seed.js";
import { createSlackTwinApp } from "../src/twin.js";
import { slackToolFixture } from "../src/tools.js";

type SlackEnvelope = { ok?: boolean; error?: string };

const steps: ParityStep[] = [
  {
    tool: "slack_search_channels",
    arguments: { query: "general" },
    capture: (body, state) => {
      const channels = (body as { channels?: Array<{ id?: string; name?: string }> }).channels ?? [];
      state.channelId = channels.find((channel) => channel.name === "general")?.id;
    },
    verify: (body) => {
      const channels = (body as { channels?: Array<{ name?: string }> }).channels ?? [];
      return channels.every((channel) => channel.name?.includes("general"))
        ? undefined
        : "search returned a channel the query does not match";
    },
  },
  {
    tool: "slack_send_message",
    arguments: (state) => ({ channel_id: state.channelId, message: "Parity message" }),
    capture: (body, state) => {
      state.ts = (body as { ts?: string }).ts;
    },
  },
  // No slack_reply_to_thread step: Slack folds the thread reply into the send
  // via thread_ts, and so does this twin.
  {
    tool: "slack_send_message",
    arguments: (state) => ({
      channel_id: state.channelId,
      message: "Parity reply",
      thread_ts: state.ts,
    }),
  },
  {
    tool: "slack_schedule_message",
    arguments: (state) => ({
      channel_id: state.channelId,
      message: "Parity scheduled",
      post_at: 4102444800,
    }),
  },
  {
    tool: "slack_add_reaction",
    arguments: (state) => ({ channel_id: state.channelId, message_ts: state.ts, emoji: "thumbsup" }),
  },
  { tool: "slack_read_channel", arguments: (state) => ({ channel_id: state.channelId }) },
  {
    tool: "slack_read_thread",
    arguments: (state) => ({ channel_id: state.channelId, message_ts: state.ts }),
  },
  {
    tool: "slack_search_users",
    arguments: { query: "alice" },
    capture: (body, state) => {
      const members = (body as { members?: Array<{ id?: string; name?: string }> }).members ?? [];
      state.aliceId = members.find((member) => member.name === "alice")?.id;
    },
  },
  { tool: "slack_read_user_profile", arguments: (state) => ({ user_id: state.aliceId }) },
  {
    tool: "slack_create_conversation",
    arguments: (state) => ({ user_ids: [state.aliceId] }),
  },
  // Slack serves two search tools over the one Web API method; the scope is
  // the only thing that separates them, so both are driven.
  {
    tool: "slack_search_public",
    arguments: { query: "Parity" },
    verify: (body) => {
      const matches = (body as { messages?: { matches?: unknown[] } }).messages?.matches ?? [];
      return matches.length > 0 ? undefined : "public search returned no match for the posted message";
    },
  },
  {
    tool: "slack_search_public_and_private",
    arguments: { query: "Parity" },
    verify: (body) => {
      const matches = (body as { messages?: { matches?: unknown[] } }).messages?.matches ?? [];
      return matches.length > 0 ? undefined : "scoped search returned no match for the posted message";
    },
  },
  {
    tool: "slack_get_reactions",
    arguments: (state) => ({ channel_id: state.channelId, message_ts: state.ts }),
    verify: (body) => {
      const reactions = (body as { message?: { reactions?: Array<{ name?: string }> } }).message?.reactions ?? [];
      return reactions.some((r) => r.name === "thumbsup")
        ? undefined
        : "reactions read did not include the thumbsup added earlier";
    },
  },
  {
    tool: "slack_list_channel_members",
    arguments: (state) => ({ channel_id: state.channelId }),
    verify: (body) => {
      const members = (body as { members?: string[] }).members ?? [];
      return members.length > 0 ? undefined : "channel member list came back empty";
    },
  },
  { tool: "slack_search_emojis", arguments: { query: "pome" } },
  // Canvases: create, edit, read back. The read is the tool the adoption had to
  // implement rather than wire — there was no canvas read in the domain.
  {
    tool: "slack_create_canvas",
    arguments: { title: "Parity canvas", content: "# Parity\nFirst line." },
    capture: (body, state) => {
      state.canvasId = (body as { canvas_id?: string }).canvas_id;
    },
  },
  {
    tool: "slack_update_canvas",
    arguments: (state) => ({
      canvas_id: state.canvasId,
      sections: [{ edit_type: "append", content: "Second line." }],
    }),
  },
  {
    tool: "slack_read_canvas",
    arguments: (state) => ({ canvas_id: state.canvasId }),
    verify: (body) => {
      const content = (body as { content?: string }).content ?? "";
      return content.includes("Second line.")
        ? undefined
        : "canvas read did not show the appended section";
    },
  },
  // Slack declares no file-upload MCP tool, so slack_read_file's subject is
  // minted over the REST route the twin still serves. A setup step is not
  // coverage — the ring-2/ring-3 check reads `tool` alone.
  {
    setup: { method: "POST", path: "/files.upload" },
    arguments: { channels: "C_GENERAL", filename: "parity.txt", content: "parity" },
    capture: (body, state) => {
      state.fileId = (body as { file?: { id?: string } }).file?.id;
    },
  },
  {
    tool: "slack_read_file",
    arguments: (state) => ({ file_id: state.fileId }),
    verify: (body) => {
      const file = (body as { file?: { name?: string } }).file;
      return file?.name === "parity.txt" ? undefined : "file read did not return the uploaded file";
    },
  },
];

await runParityCli({
  app: createSlackTwinApp({ seed: defaultSeedState() }),
  twin: "slack",
  inventory: loadFidelityInventory(join(import.meta.dirname, "..", "fidelity.inventory.json")),
  fixtureToolNames: [...slackToolFixture.toolNames],
  steps,
  claims: { team_id: "T_POME", login: "pome-agent" },
  stepVerify: (body) => {
    const envelope = body as SlackEnvelope;
    return envelope.ok === false ? `slack error envelope: ${envelope.error ?? "unknown"}` : undefined;
  },
  restProbes: [
    { surface: "unsupported-rest", method: "POST", path: "/admin.conversations.search", status: 501, expectUnsupportedEnvelope: true },
    // Named cold rows: the loud 501 is part of the contract.
    { surface: "cold:chat.postEphemeral", method: "POST", path: "/chat.postEphemeral", status: 501, expectUnsupportedEnvelope: true },
    { surface: "cold:files.getUploadURLExternal", method: "GET", path: "/files.getUploadURLExternal", status: 501, expectUnsupportedEnvelope: true },
    { surface: "cold:usergroups.list", method: "GET", path: "/usergroups.list", status: 501, expectUnsupportedEnvelope: true },
    { surface: "cold:views.publish", method: "POST", path: "/views.publish", status: 501, expectUnsupportedEnvelope: true },
  ],
});
