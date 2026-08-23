// SPDX-License-Identifier: Apache-2.0
// The reactions absence guard, at the twin whose state it reads.

import { describe, expect, it } from "vitest";
import { noReactionAdded } from "../src/check-messages.js";
import type { SlackCheckState } from "../src/check-state.js";
import { publicChannel } from "../src/check-worlds.js";

const args = { reaction: "white_check_mark", channel: "general" };

describe("slack.no-reaction-added", () => {
  it("passes when the named channel carries no matching reaction", () => {
    const final: SlackCheckState = { channels: [publicChannel("general")], reactions: [] };
    const outcome = noReactionAdded.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(true);
    expect(outcome.status).toBeUndefined();
  });

  it("fails when the reaction is present in the channel", () => {
    const channel = publicChannel("general");
    const final: SlackCheckState = {
      channels: [channel],
      reactions: [{ channel_id: channel.id, message_ts: "1.0", name: "white_check_mark", user_id: "U1" }],
    };
    const outcome = noReactionAdded.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
  });

  it("SKIPS on an absent reactions section — absent is not the same as none", () => {
    // `?? []` used to read a missing `reactions` collection the same as an empty one,
    // so a negative criterion scored a free pass over a world it never actually.
    const final: SlackCheckState = { channels: [publicChannel("general")] };
    const outcome = noReactionAdded.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("state_incomplete");
  });

  it("SKIPS on an absent channel — resolveChannel's own guard, unchanged by this fix", () => {
    const final: SlackCheckState = { channels: [] };
    const outcome = noReactionAdded.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("channel_not_found");
  });
});
