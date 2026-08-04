// How a declared check reads the exported Gmail mailbox (F-1128).
//
// These are the shapes that produce a WRONG VERDICT if read naively, so each
// case names the verdict it prevents rather than the field it touches.

import { describe, expect, it } from "vitest";
import {
  draftRecipients,
  isTruncated,
  labelIdsFor,
  messageCarriesLabel,
  resolveLabelByName,
  resolveMessage,
  type GmailCheckState,
} from "../src/check-state.js";

const MB = "pome-agent@pome-twin.test";

function state(overrides: Partial<GmailCheckState> = {}): GmailCheckState {
  return {
    mailboxes: [{ email: MB }],
    messages: [{ mailboxEmail: MB, id: "msg_support", to: [MB], subject: "Production export is stuck" }],
    drafts: [],
    labels: [
      { mailboxEmail: MB, id: "INBOX", name: "INBOX", type: "system" },
      { mailboxEmail: MB, id: "Label_follow_up", name: "Follow Up", type: "user" },
    ],
    messageLabels: [{ mailboxEmail: MB, messageId: "msg_support", labelId: "INBOX" }],
    exportBounds: { messageBodiesOmitted: true, largeMailbox: false, truncatedCollections: [] },
    ...overrides,
  };
}

describe("resolveMessage", () => {
  it("finds a message by id", () => {
    const found = resolveMessage(state(), "msg_support");
    expect("found" in found && found.found.subject).toBe("Production export is stuck");
  });

  it("says state_incomplete when the collection is absent, rather than not_found", () => {
    // A negative criterion must not score a free pass over an export that never
    // carried the collection. The two are different facts and get different names.
    expect(resolveMessage(state({ messages: null }), "msg_support")).toEqual({
      missing: "state_incomplete",
    });
  });

  it("says message_not_found when the collection is present but the id is not", () => {
    expect(resolveMessage(state(), "msg_ghost")).toEqual({
      missing: 'message_not_found ("msg_ghost")',
      // F-1197 — the refusal names the collection it scanned, so a reader can
      // open it and see the id is genuinely not there.
      searched: "/messages",
    });
  });

  it("refuses an id that appears in more than one mailbox", () => {
    // Gmail ids are minted per mailbox, so `deliveryMode: "seeded-mailboxes"` can
    // put the same id in two. Grading whichever sorted first is the first-match
    // -wins defect github's `{repo}` slot exists to close; gmail's sentences carry
    // no mailbox, so the honest move is to refuse.
    const two = state({
      mailboxes: [{ email: MB }, { email: "other@pome-twin.test" }],
      messages: [
        { mailboxEmail: MB, id: "msg_support" },
        { mailboxEmail: "other@pome-twin.test", id: "msg_support" },
      ],
    });
    expect(resolveMessage(two, "msg_support")).toEqual({
      missing: 'message_ambiguous ("msg_support" exists in 2 mailboxes)',
      searched: "/messages",
    });
  });

  it("refuses when the messages collection was truncated and the id is absent", () => {
    // Absent-from-a-truncated-collection is not absent. Reporting `not_found`
    // here would false-fail a correct agent on a large mailbox.
    const big = state({
      exportBounds: { messageBodiesOmitted: true, largeMailbox: true, truncatedCollections: ["messages"] },
    });
    expect(resolveMessage(big, "msg_ghost")).toEqual({
      missing: 'collection_truncated ("messages")',
      searched: "/messages",
    });
  });

  it("still resolves a message that survived truncation", () => {
    const big = state({
      exportBounds: { messageBodiesOmitted: true, largeMailbox: true, truncatedCollections: ["messages"] },
    });
    expect("found" in resolveMessage(big, "msg_support")).toBe(true);
  });
});

describe("labelIdsFor", () => {
  it("matches a user label by its id, which is what the corpus names", () => {
    expect(labelIdsFor(state(), "Label_follow_up").has("label_follow_up")).toBe(true);
  });

  it("also matches a user label by its display name", () => {
    // The seed writes `{ id: "Label_follow_up", name: "Follow Up" }`, and an
    // author may reasonably name either. The twin's own seeder keys its lookup on
    // the lower-cased NAME, so this follows the twin rather than inventing a rule.
    expect(labelIdsFor(state(), "Follow Up").has("label_follow_up")).toBe(true);
  });

  it("matches a system label, whose id and name are the same string", () => {
    expect(labelIdsFor(state(), "INBOX").has("inbox")).toBe(true);
  });

  it("keeps the bare wanted value, so a truncated labels collection still joins", () => {
    // `messageLabels` rows carry the bare label id even when `labels` is capped.
    expect(labelIdsFor({ ...state(), labels: null }, "SENT").has("sent")).toBe(true);
  });
});

describe("messageCarriesLabel", () => {
  it("reads the join, not a nested field", () => {
    // The path is the JOIN TABLE, not a row in it: the answer is a boolean this
    // function computes, and the tree holds no such value (F-1197).
    expect(messageCarriesLabel(state(), "msg_support", "INBOX")).toEqual({
      found: true,
      path: "/messageLabels",
    });
  });

  it("answers false for a label the message does not carry", () => {
    expect(messageCarriesLabel(state(), "msg_support", "Label_follow_up")).toEqual({
      found: false,
      path: "/messageLabels",
    });
  });

  it("says state_incomplete when messageLabels is absent", () => {
    expect(messageCarriesLabel(state({ messageLabels: null }), "msg_support", "INBOX")).toEqual({
      missing: "state_incomplete",
    });
  });

  it("refuses when messageLabels was truncated", () => {
    const big = state({
      exportBounds: {
        messageBodiesOmitted: true,
        largeMailbox: true,
        truncatedCollections: ["messageLabels"],
      },
    });
    expect(messageCarriesLabel(big, "msg_support", "Label_follow_up")).toEqual({
      missing: 'collection_truncated ("messageLabels")',
      searched: "/messageLabels",
    });
  });
});

describe("resolveLabelByName", () => {
  it("matches on the display name, case-insensitively", () => {
    // "A label named X exists" asks about the NAME. The twin's seeder lower-cases
    // for its own uniqueness lookup, so this matches the twin's notion of same.
    const hit = resolveLabelByName(state(), "follow up");
    expect("found" in hit && hit.found.id).toBe("Label_follow_up");
  });

  it("does not match on the id, so an author cannot mistake one for the other", () => {
    expect(resolveLabelByName(state(), "Label_follow_up")).toEqual({
      missing: 'label_not_found ("Label_follow_up")',
      searched: "/labels",
    });
  });

  it("says state_incomplete when labels is absent", () => {
    expect(resolveLabelByName(state({ labels: null }), "Follow Up")).toEqual({
      missing: "state_incomplete",
    });
  });
});

describe("draftRecipients", () => {
  it("joins the draft to its backing message, where the addressing actually lives", () => {
    // The exported `drafts` row is {mailboxEmail, id, messageId, createdAt,
    // updatedAt} — no recipient anywhere on it. A predicate that read the draft
    // row alone would answer "no draft is addressed to anyone", always.
    const withDraft = state({
      drafts: [{ mailboxEmail: MB, id: "draft_ack", messageId: "draft_ack_message" }],
      messages: [
        { mailboxEmail: MB, id: "msg_support", to: [MB] },
        { mailboxEmail: MB, id: "draft_ack_message", to: ["bob@example.com"], cc: ["carol@example.com"] },
      ],
    });
    expect(draftRecipients(withDraft, withDraft.drafts![0]!)).toEqual([
      "bob@example.com",
      "carol@example.com",
    ]);
  });

  it("returns nothing for a draft whose message did not survive the export", () => {
    const orphan = state({ drafts: [{ mailboxEmail: MB, id: "draft_x", messageId: "gone" }] });
    expect(draftRecipients(orphan, orphan.drafts![0]!)).toEqual([]);
  });
});

describe("isTruncated", () => {
  it("is false when nothing was capped", () => {
    expect(isTruncated(state(), "messages")).toBe(false);
  });

  it("tolerates an export with no bounds block at all", () => {
    // Older snapshots predate `exportBounds`. Treating absence as "truncated"
    // would skip every criterion on them; treating it as "not truncated" is the
    // same answer a pre-cap export would have given honestly.
    expect(isTruncated(state({ exportBounds: null }), "messages")).toBe(false);
  });
});
