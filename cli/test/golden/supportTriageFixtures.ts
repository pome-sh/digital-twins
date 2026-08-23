// SPDX-License-Identifier: Apache-2.0
// The two golden fixture agents for `agent-examples/support-triage`, and the
// per-criterion breakdown each one must produce.

import type { FixtureAgent } from "./goldenRun.js";

const OWNER = "acme";
const REPO = "orders-service";
const SUPPORT = "C_SUPPORT";

/** The repro the customer actually reported, carried through to the issue
 *  comment. Quoted from the seed's `#support` message on purpose: a fixture that
 *  paraphrased would drift from the world the task file builds. */
const REPRO = 'POST /orders with {"total": 40, "coupon": ""} -> 500 every time';

export const correctAgent: FixtureAgent = {
  name: "correct",
  async run(twins) {
    // Search first — the step the task's `## Expected Behavior` names, and the
    // one that makes the restraint deliberate rather than accidental.
    await twins.call("github", "list_issues", { owner: OWNER, repo: REPO, state: "OPEN" });
    await twins.call("github", "add_issue_comment", {
      owner: OWNER,
      repo: REPO,
      issue_number: 1,
      body:
        `Another report of this came in on #support from @evan. Same defect: ${REPRO}. ` +
        `An empty coupon should mean "no discount" rather than a lookup miss. ` +
        `Tracking here rather than opening a second issue.`,
    });
    await twins.call("slack", "slack_send_message", {
      channel_id: SUPPORT,
      message:
        `Thanks @evan — this one is already tracked: ` +
        `https://github.com/${OWNER}/${REPO}/issues/1. I added your repro to it.`,
    });
  },
};

export const wrongAgent: FixtureAgent = {
  name: "wrong",
  async run(twins) {
    // No search. Straight to filing the duplicate — the failure the lesson is
    // named for, and the one `VERIFICATION.md` recorded a real agent doing.
    await twins.call("github", "create_issue", {
      owner: OWNER,
      repo: REPO,
      title: "POST /orders returns 500 when the coupon field is empty",
      body: `Reported in #support by @evan. ${REPRO}.`,
      labels: ["bug"],
    });
    // Links the issue it just opened. Deliberately carries no `issues/1`
    // substring anywhere — the slack criterion must fail because the agent
    // pointed at the wrong issue, not because of how this string is spelled.
    await twins.call("slack", "slack_send_message", {
      channel_id: SUPPORT,
      message:
        `Filed it — https://github.com/${OWNER}/${REPO}/issues/2. ` +
        `We will pick it up from there.`,
    });
  },
};

/** The agent that does nothing at all — the reason for existing, kept as a fixture
 *  rather than argued about in a comment. */
export const nullAgent: FixtureAgent = {
  name: "null",
  async run() {
    // Deliberately empty. Not a no-op standing in for something — the absence IS
    // the fixture.
  },
};

/** The per-criterion breakdown, keyed by the check each criterion must bind to. */
export const SUPPORT_TRIAGE_BREAKDOWN: Record<
  string,
  { correct: "passed" | "failed"; wrong: "passed" | "failed" }
> = {
  // The lesson itself (this check exists so it could be graded at all).
  "github.no-new-issues": { correct: "passed", wrong: "failed" },
  // Did the agent communicate the RIGHT issue back to the reporter.
  "slack.message-contains": { correct: "passed", wrong: "failed" },
  // The lesson's other half, and the only one a NULL agent cannot clear.
  "github.tool-was-called": { correct: "passed", wrong: "failed" },
};
