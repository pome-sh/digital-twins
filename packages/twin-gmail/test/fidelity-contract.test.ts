// SPDX-License-Identifier: Apache-2.0
//
// State-shape parity for the declared check vocabulary (F-1128).
//
// SCOPE, deliberately narrow: the tool-list / fidelity.inventory.json / REST
// rings already run for this twin through `scripts/fidelity-parity.ts`
// (`npm run fidelity:parity -w @pome-sh/twin-gmail` in CI). Re-asserting them
// here would be the second drift gate F-1128 was told not to build. What was
// MISSING is the arm below: nothing checked that `exportGmailState()` still
// carries the fields `check-state.ts` reads.
//
// That absence is exactly why pome-cloud's hand-maintained mirror of this shape
// could drift for a milestone with nothing to notice. twin-slack added the same
// arm in F-1126 and it caught a real field on its first run (`user` vs
// `user_id`); this is the gmail half of that lesson.

import { describe, expect, it } from "vitest";
import { openGmailTwinDatabase } from "../src/db.js";
import { GmailDomain } from "../src/domain/index.js";
import { defaultSeedState, parseSeed } from "../src/seed.js";
import {
  draftRecipients,
  messageCarriesLabel,
  resolveLabelByName,
  resolveMessage,
  type GmailCheckState,
} from "../src/check-state.js";
import { draftAddressedTo, draftCountAtLeast } from "../src/check-drafts.js";
import { labelExists } from "../src/check-labels.js";
import { messageHasLabel } from "../src/check-messages.js";

// The same composition pome-cloud's `LOADERS.gmail` performs: open an in-memory
// database, seed it, export. If this drifts, the cloud's author-time door drifts
// with it.
function exported(seed: unknown = defaultSeedState()): GmailCheckState {
  const db = openGmailTwinDatabase(":memory:");
  try {
    const domain = new GmailDomain(db);
    domain.seed(parseSeed(seed));
    return domain.exportState() as unknown as GmailCheckState;
  } finally {
    db.close();
  }
}

describe("state-shape parity", () => {
  it("finds every top-level key GmailCheckState names", () => {
    const state = exported() as unknown as Record<string, unknown>;
    for (const key of ["mailboxes", "messages", "drafts", "labels", "messageLabels", "exportBounds"]) {
      expect(state, `exportGmailState() no longer produces "${key}"`).toHaveProperty(key);
    }
  });

  it("finds every message field the model reads, on a real exported row", () => {
    const messages = exported().messages!;
    expect(messages.length).toBeGreaterThan(0);
    for (const field of ["mailboxEmail", "id", "to", "subject"]) {
      expect(messages[0]!, `exported messages no longer carry "${field}"`).toHaveProperty(field);
    }
  });

  it("confirms message bodies really are digested away, never readable", () => {
    // The constraint that rules out a whole class of check on this twin. If the
    // twin ever started exporting `text`, a body-scanning check would become
    // possible — and `check-state.ts`'s comment saying it is not would be a lie.
    const message = exported().messages![0]! as unknown as Record<string, unknown>;
    expect(message.bodyOmitted).toBe(true);
    expect(message).not.toHaveProperty("text");
    expect(message).not.toHaveProperty("html");
    expect(message).not.toHaveProperty("snippet");
  });

  it("confirms `to` really arrives as a parsed ARRAY, not a JSON string", () => {
    // The export selects `to_json AS "to"` and its `rows()` helper JSON-parses
    // it. A predicate written against a string would silently match nothing.
    const message = exported().messages!.find((m) => (m.to ?? []).length > 0);
    expect(Array.isArray(message!.to)).toBe(true);
  });

  it("confirms labels are a flat JOIN, not nested under their message", () => {
    // `messageLabels` is keyed by `messageId`/`labelId` at the top level. A
    // predicate that assumed nesting would find none — the same trap slack's
    // reactions carry.
    const state = exported();
    expect(state.messageLabels!.length).toBeGreaterThan(0);
    for (const field of ["mailboxEmail", "messageId", "labelId"]) {
      expect(state.messageLabels![0]!, `messageLabels rows no longer carry "${field}"`).toHaveProperty(field);
    }
    expect(state.messages![0]!).not.toHaveProperty("labels");
    expect(state.messages![0]!).not.toHaveProperty("labelIds");
  });

  it("confirms a user label's id and display name really do differ", () => {
    // `Label_follow_up` / `Follow Up`. This is the whole reason
    // `gmail.message-has-label` (id-or-name) and `gmail.label-exists` (name only)
    // are two checks rather than one.
    const label = exported().labels!.find((l) => l.type === "user");
    expect(label, "the default seed defines no user label to check the shape against").toBeTruthy();
    expect(label!.id).not.toBe(label!.name);
  });

  it("confirms a system label carries id === name", () => {
    const inbox = exported().labels!.find((l) => l.id === "INBOX");
    expect(inbox!.name).toBe("INBOX");
  });

  it("confirms a draft row carries NO addressing, only a message join key", () => {
    // The shape that makes `gmail.draft-addressed-to` a join. If the twin ever
    // put `to` on the draft row, the check would still work — but the comment
    // explaining why it joins would be wrong, and the next reader would simplify
    // it into a bug.
    const draft = exported().drafts![0]! as unknown as Record<string, unknown>;
    expect(draft).toHaveProperty("messageId");
    expect(draft).not.toHaveProperty("to");
    expect(draft).not.toHaveProperty("cc");
  });

  it("resolves a draft's recipients through the join, on a real export", () => {
    const state = exported();
    const recipients = draftRecipients(state, state.drafts![0]!);
    expect(recipients.length).toBeGreaterThan(0);
  });

  it("reports no truncation on a seed this small", () => {
    expect(exported().exportBounds!.truncatedCollections).toEqual([]);
  });
});

describe("the declared checks, against a real exported mailbox", () => {
  // The default seed IS the task-22-shaped inbox (`agentPathInboxMailbox`):
  // an unread support mail from Alice, a `Follow Up` label defined but not
  // applied, and one unsent draft. So the checks can be graded against a real
  // export in-package, without reaching into `cli/tasks/` and inverting the
  // dependency direction. The corpus-wide measurement is pome-cloud's job.
  const state = exported();

  it("reads msg_support out of a real export", () => {
    expect("found" in resolveMessage(state, "msg_support")).toBe(true);
  });

  it("grades `Message msg_support has label Label_follow_up` FALSE on the seed", () => {
    // A healthy FAIL_TO_PASS: the seed leaves the label defined but unapplied, so
    // the examinee has to act. A criterion already satisfied by its own seed is
    // one a do-nothing agent scores.
    const verdict = messageHasLabel.evaluate(
      { message: "msg_support", label: "Label_follow_up" },
      { seed: null, final: state, tape: null },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.status ?? "failed").toBe("failed");
  });

  it("grades that same criterion TRUE once the label is applied", () => {
    // The other arm. Without it the case above proves only that the criterion CAN
    // fail — not that it tells a labelling agent from an idle one.
    const applied: GmailCheckState = {
      ...state,
      messageLabels: [
        ...state.messageLabels!,
        { mailboxEmail: state.mailboxes![0]!.email, messageId: "msg_support", labelId: "Label_follow_up" },
      ],
    };
    const verdict = messageHasLabel.evaluate(
      { message: "msg_support", label: "Label_follow_up" },
      { seed: null, final: applied, tape: null },
    );
    expect(verdict.passed).toBe(true);
  });

  it("accepts the label by its DISPLAY NAME too, on the real export", () => {
    expect(messageCarriesLabel(state, "msg_build", "Build")).toEqual({
      found: true,
      path: "/messageLabels",
    });
  });

  it("grades `A draft addressed to alice@example.com exists` FALSE on the seed", () => {
    // The seed's one draft goes to somebody else, so this is a real positive.
    const verdict = draftAddressedTo.evaluate(
      { email: "alice@example.com" },
      { seed: null, final: state, tape: null },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.status ?? "failed").toBe("failed");
  });

  it("grades `A label named Follow Up exists` TRUE — the seed defines it", () => {
    // `gmail.label-exists` asks about DEFINITION, not application. The seed
    // defines `Follow Up` and applies it to nothing, and this check correctly
    // says the label exists. That distinction is what its description exists to
    // carry, and it is the same shape as `github.no-new-labels`.
    const verdict = labelExists.evaluate(
      { label: "Follow Up" },
      { seed: null, final: state, tape: null },
    );
    expect(verdict.passed).toBe(true);
    expect("found" in resolveLabelByName(state, "Follow Up")).toBe(true);
  });

  it("counts the seed's drafts, so an already-satisfied threshold is visible here", () => {
    // `At least two drafts exist` is task 23's criterion, and task 23's seed
    // ships two. The default seed ships one, so it fails here — the point of the
    // assertion is that the count is READ from the export rather than assumed.
    const verdict = draftCountAtLeast.evaluate(
      { count: "two" },
      { seed: null, final: state, tape: null },
    );
    expect(verdict.reason).toContain(`${state.drafts!.length} draft(s) exist`);
    expect(verdict.passed).toBe(state.drafts!.length >= 2);
  });
});
