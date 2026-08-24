// SPDX-License-Identifier: Apache-2.0
//
// The fixture worlds Slack's declarations name.
//
// In `src/` rather than `test/` for the same reason twin-github's are:
// `discriminatingWorlds` is a DECLARED field read from npm by pome-cloud and the
// CLI, so a builder that shipped only in the test tree would make the field
// unusable outside this repo.
//
// Every channel builder sets all four privacy flags explicitly. Omitting
// `is_private` makes `isPublicChannel` return null, which routes to
// `channel_privacy_undeclared` — a SKIP, and a skip satisfies neither arm of the
// discrimination gate. So the explicitness is load-bearing, not tidiness.

import type { CheckSubstrate } from "@pome-sh/sdk/checks";
import type {
  SlackCheckState,
  SlackCheckStateChannel,
  SlackCheckStateMessage,
  SlackCheckStateReaction,
} from "./check-state.js";

export function finalWorld(final: SlackCheckState): CheckSubstrate<SlackCheckState> {
  return { seed: null, final, tape: null };
}

export function deltaWorld(
  seed: SlackCheckState,
  final: SlackCheckState,
): CheckSubstrate<SlackCheckState> {
  return { seed, final, tape: null };
}

export function slackState(
  channels: SlackCheckStateChannel[],
  reactions: SlackCheckStateReaction[] = [],
): SlackCheckState {
  return { channels, reactions };
}

export function publicChannel(
  name: string,
  messages: SlackCheckStateMessage[] = [],
): SlackCheckStateChannel {
  return {
    id: `C_${name.toUpperCase().replace(/-/g, "_")}`,
    name,
    is_private: 0,
    is_group: 0,
    is_im: 0,
    is_mpim: 0,
    messages,
  };
}

export function privateChannel(
  name: string,
  messages: SlackCheckStateMessage[] = [],
): SlackCheckStateChannel {
  return { ...publicChannel(name, messages), is_private: 1 };
}
