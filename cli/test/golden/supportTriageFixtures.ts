// SPDX-License-Identifier: Apache-2.0
//
// The two golden fixture agents for `agent-examples/support-triage` (F-646), and the
// per-criterion breakdown each one must produce.
//
// The task's lesson is restraint: a bug report arrives in `#support`, issue #1
// in `acme/orders-service` ALREADY tracks it, and the agent is supposed to
// comment on #1 and link it back rather than open a second issue. So the two
// runs differ in exactly the behaviour the lesson is about —
//
//   correct  reads the open issues, comments on #1 with the customer's repro,
//            posts #1's link back to #support. Opens nothing.
//   wrong    opens the duplicate and links THAT back instead.
//
// Both are scripts. There is no model in this file, no prompt, and no branch
// that could take a different path on a different day: the same call list runs
// every time, which is what makes the expected breakdown below an assertion
// rather than a snapshot.
//
// WHY THE WRONG RUN ALSO GETS SLACK WRONG. It would be easy to write a wrong
// agent that fails only `no-new-issues`, and it would be a weaker fixture: the
// pair would then prove one check discriminates, not that the run's verdict
// does. A duplicate-filing agent genuinely links the issue it just opened, so
// failing both is the honest consequence of one wrong decision rather than two
// injected faults — and it puts the aggregate at a clean 0 against a threshold
// of 100.

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

/**
 * The agent that does nothing at all — F-1521's reason for existing, kept as a
 * fixture rather than argued about in a comment.
 *
 * It is NOT a third column of the breakdown below. `correct` and `wrong` are a
 * discriminating PAIR over the task's lesson (file a duplicate, or don't), and a
 * null agent is not a third opinion about that lesson — it is a check on whether
 * the exam can be cleared without taking part. So it gets its own assertion,
 * which is deliberately about ONE criterion.
 *
 * Doing nothing satisfies `github.no-new-issues` perfectly: no issue was opened,
 * because nothing was. A prohibition cannot tell "held the line" from "never
 * showed up", and before a positive assertion existed that was the whole exposure
 * — six exam tasks were cleared this way.
 */
export const nullAgent: FixtureAgent = {
  name: "null",
  async run() {
    // Deliberately empty. Not a no-op standing in for something — the absence IS
    // the fixture.
  },
};

/**
 * The per-criterion breakdown, keyed by the check each criterion must bind to.
 *
 * KEYED BY CHECK ID, not by sentence and not by index. A criterion's English can
 * be re-worded without changing what grades it, and an index says nothing a
 * reader can check. The id is the thing a report names.
 *
 * EXHAUSTIVE IN BOTH DIRECTIONS, and F-1521 is the case that proves it worked.
 * The gate fails when the task carries a `[code]` criterion this table does not
 * name, and fails when this table names one the task does not carry — so the
 * positive tape assertion could not arrive silently. It landed exactly the way
 * the slot predicted: a red gate naming the missing row, one entry added, no
 * vocabulary declared here and nothing redesigned, because the harness was
 * already capturing the tape scoped per twin.
 */
export const SUPPORT_TRIAGE_BREAKDOWN: Record<
  string,
  { correct: "passed" | "failed"; wrong: "passed" | "failed" }
> = {
  // The lesson itself (F-1198 declared this check so it could be graded at all).
  "github.no-new-issues": { correct: "passed", wrong: "failed" },
  // Did the agent communicate the RIGHT issue back to the reporter.
  "slack.message-contains": { correct: "passed", wrong: "failed" },
  // F-1521 — the lesson's other half, and the only one a NULL agent cannot
  // clear. `no-new-issues` and this one fail in opposite directions: an agent
  // that does nothing opens no duplicate and passes the prohibition, and leaves
  // no comment so it fails this. The wrong fixture fails it for the live reason
  // instead — it called `create_issue`, never `add_issue_comment`, so the tape
  // names an action and it is not this one.
  "github.tool-was-called": { correct: "passed", wrong: "failed" },
};
