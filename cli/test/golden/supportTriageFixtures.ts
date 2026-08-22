// SPDX-License-Identifier: Apache-2.0
//
// The two golden fixture agents for `agent-examples/support-triage` (F-646), and
// the per-criterion breakdown each one must produce.
//
// The task's lesson is ROUTING UNDER A LOCAL CONVENTION. Five issues are open in
// `acme/orders-service`. `#47` is the textual bullseye — its title and body carry
// the customer's exact words — and it is NOT the answer. `#23` is the tracking
// issue the org consolidates onto, and the rule saying so exists in exactly one
// place: a seeded `docs/triage-policy.md` the agent is never told to read. So the
// two runs differ in the behaviour the lesson is about —
//
//   correct  reads the open issues, comments on #23 naming #47 as the duplicate,
//            posts #23's link back to #support. Opens nothing.
//   wrong    reads the open issues, opens a duplicate anyway, and points #support
//            at the new issue while citing #47 as "related".
//
// Both are scripts. There is no model in this file, no prompt, and no branch
// that could take a different path on a different day: the same call list runs
// every time, which is what makes the expected breakdown below an assertion
// rather than a snapshot.
//
// WHY THE WRONG RUN FAILS ALL FIVE. It would be easy to write a wrong agent that
// fails only `no-new-issues`, and it would be a weaker fixture: the pair would
// then prove one check discriminates, not that the run's verdict does. It would
// also no longer reach 0, which is F-646's headline and this gate's sharpest
// property — every criterion that silently stopped discriminating would move the
// number OFF zero, and there is no other value with that quality.
//
// Reaching 0 on the five-criterion task needs the wrong run to both open a
// duplicate AND put `issues/47` in front of the reporter. Measured against the
// alternatives before it was written this way: an agent that only files the
// duplicate scores 20 (it never names #47, so the negative slack guard passes),
// and one that only mis-routes to #47 scores 40 (it opens nothing and does call
// `add_issue_comment`). Both are real failures — the second is what
// `claude-sonnet-5` actually did in 3 of its 4 measured failures — but neither is
// a floor, and a gate whose "known-wrong" answer is a mid-range number cannot
// tell a grading regression from a fixture that drifted.
//
// AND WHY IT SEARCHES FIRST. Citing #47 while never having looked it up would be
// two injected faults wearing one fixture. Searching, finding the textual
// bullseye, and consolidating onto it anyway is ONE wrong decision with two
// honest consequences — and it is the decision the measured failures are made of.

import type { FixtureAgent } from "./goldenRun.js";

const OWNER = "acme";
const REPO = "orders-service";
const SUPPORT = "C_SUPPORT";

/** The tracking issue the org's convention routes to. Not the textual match. */
const TRACKING = 23;
/** The textual bullseye: same words as the customer, wrong destination. */
const DECOY = 47;

/** The repro the customer actually reported, carried through to the issue
 *  comment. Quoted from the seed's `#support` message on purpose: a fixture that
 *  paraphrased would drift from the world the task file builds. */
const REPRO = 'POST /orders with {"total": 40, "coupon": ""} -> 500 every time';

export const correctAgent: FixtureAgent = {
  name: "correct",
  async run(twins) {
    // Search first — the step the task's `## Expected Behavior` names, and the
    // one that makes the routing deliberate rather than accidental.
    await twins.call("github", "list_issues", { owner: OWNER, repo: REPO, state: "OPEN" });
    await twins.call("github", "add_issue_comment", {
      owner: OWNER,
      repo: REPO,
      issue_number: TRACKING,
      body:
        `Another report of this came in on #support from @evan. Same defect: ${REPRO}. ` +
        `An empty coupon should mean "no discount" rather than a lookup miss. ` +
        `Folding #${DECOY} in here rather than opening a third issue for the same bug.`,
    });
    await twins.call("slack", "slack_send_message", {
      channel_id: SUPPORT,
      message:
        `Thanks @evan — this one is already tracked: ` +
        `https://github.com/${OWNER}/${REPO}/issues/${TRACKING}. I added your repro to it.`,
    });
  },
};

export const wrongAgent: FixtureAgent = {
  name: "wrong",
  async run(twins) {
    // It DID search. The failure is not laziness — it is reading the textual
    // match as the destination and never learning the org has a convention.
    await twins.call("github", "list_issues", { owner: OWNER, repo: REPO, state: "OPEN" });
    await twins.call("github", "create_issue", {
      owner: OWNER,
      repo: REPO,
      title: "POST /orders returns 500 when the coupon field is empty",
      body: `Reported in #support by @evan. ${REPRO}.`,
      labels: ["bug"],
    });
    // Links the issue it just opened, and cites the decoy as context — the
    // natural thing to write having found #47 and filed anyway. Carries no
    // `issues/${TRACKING}` substring: the positive slack criterion must fail
    // because the agent pointed at the wrong issue, not because of spelling.
    await twins.call("slack", "slack_send_message", {
      channel_id: SUPPORT,
      message:
        `Filed it — https://github.com/${OWNER}/${REPO}/issues/53. ` +
        `Looks like the same thing as https://github.com/${OWNER}/${REPO}/issues/${DECOY}. ` +
        `We will pick it up from there.`,
    });
  },
};

/**
 * The agent that does nothing at all — F-1521's reason for existing, kept as a
 * fixture rather than argued about in a comment.
 *
 * It is NOT a third column of the breakdown below. `correct` and `wrong` are a
 * discriminating PAIR over the task's lesson (route to the tracking issue, or
 * don't), and a null agent is not a third opinion about that lesson — it is a
 * check on whether the exam can be cleared without taking part. So it gets its
 * own assertion, which is deliberately about the criteria a prohibition cannot
 * speak for.
 *
 * Doing nothing satisfies BOTH negative criteria perfectly: no issue was opened
 * and no message named the decoy, because nothing happened at all. A prohibition
 * cannot tell "held the line" from "never showed up", and before a positive
 * assertion existed that was the whole exposure — six exam tasks were cleared
 * this way.
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
 *
 * It caught the reseed the same way. Hardening this task from one issue to five
 * took it from three `[code]` criteria to five, and this table redded naming
 * both new rows before a single expected value had been argued about.
 */
export const SUPPORT_TRIAGE_BREAKDOWN: Record<
  string,
  { correct: "passed" | "failed"; wrong: "passed" | "failed" }
> = {
  // Did the agent route to the TRACKING issue, and record the decoy against it.
  // The one criterion that reads the lesson directly.
  "github.issue-comment-contains": { correct: "passed", wrong: "failed" },
  // Did the agent communicate the RIGHT issue back to the reporter.
  "slack.message-contains": { correct: "passed", wrong: "failed" },
  // The negative half of the same question. `message-contains` can be satisfied
  // by an agent that names #23 among a list of everything it found; this one
  // says the decoy must not be what #support is pointed at. Seed-true, and NOT
  // marked `always-scored` on purpose — the hosted grader excludes a seed-true
  // criterion only when it also holds at finish, so leaving the marker off keeps
  // it a real failure for anyone who breaks it while denying a do-nothing agent
  // the free pass the marker would hand back.
  "slack.no-message-containing": { correct: "passed", wrong: "failed" },
  // The lesson's restraint half (F-1198 declared this check so it could be
  // graded at all). Seed-true, unmarked, for the reason above.
  "github.no-new-issues": { correct: "passed", wrong: "failed" },
  // F-1521 — the only criterion a NULL agent cannot clear by absence. The two
  // negatives above and this one fail in opposite directions: an agent that does
  // nothing opens no duplicate and names no decoy, so it passes both, and leaves
  // no comment so it fails this. The wrong fixture fails it for the live reason
  // instead — it called `create_issue`, never `add_issue_comment`, so the tape
  // names an action and it is not this one.
  "github.tool-was-called": { correct: "passed", wrong: "failed" },
};
