// SPDX-License-Identifier: Apache-2.0
//
// Slack — the domain runtime pome-cloud boots in-process. See `./github.ts` for
// why the domain and the opener come through the twin's package root while the
// seed and the vocabulary come through narrow subpaths.
export { SlackDomain } from "@pome-sh/twin-slack";
export { openSlackTwinDatabase, migrate, resetDatabase } from "@pome-sh/twin-slack";
export type {
  BookmarkRow,
  ChannelMemberRow,
  ChannelRow,
  FileRow,
  MessageRow,
  PinRow,
  ReactionRow,
  ScheduledMessageRow,
  SlackStateSeed,
  SlackTwinDatabase,
  UserRow,
  WorkspaceRow,
} from "@pome-sh/twin-slack";

export { defaultSeedState, parseSeed, seedSchema } from "@pome-sh/twin-slack/seed";

export { SLACK_CHECKS } from "@pome-sh/twin-slack/checks";
export type { Check } from "@pome-sh/twin-slack/checks";
export type {
  SlackCheckState,
  SlackCheckStateChannel,
  SlackCheckStateMessage,
  SlackCheckStateReaction,
} from "@pome-sh/twin-slack/checks";
