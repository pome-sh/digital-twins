// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { composeMime, GmailDomain, openGmailTwinDatabase } from "../src/index.js";

const EMAIL = "pome-agent@pome-twin.test";

function domain() {
  const db = openGmailTwinDatabase(":memory:");
  const gmail = new GmailDomain(db);
  gmail.seed({
    primaryMailbox: { email: EMAIL, displayName: "Concurrency" },
    clock: "2025-01-01T00:00:00.000Z",
  });
  return gmail;
}

function raw(subject: string, messageId?: string) {
  return composeMime({
    from: EMAIL,
    to: ["recipient@example.test"],
    subject,
    text: `body ${subject}`,
    date: "2025-01-01T12:00:00.000Z",
    messageId: messageId ?? `${subject.toLowerCase().replace(/\W/g, "-")}@concurrency.test`,
  });
}

describe("Gmail concurrency suite", () => {
  it("rejects draft double-send after the first succeeds", () => {
    const gmail = domain();
    const draft = gmail.createDraft(EMAIL, raw("Double send"));
    const first = gmail.sendDraft(EMAIL, draft.id);
    expect(first.sender.labelIds).toContain("SENT");
    expect(() => gmail.sendDraft(EMAIL, draft.id)).toThrow(/Draft|not found|Not Found/i);
  });

  it("rejects duplicate label create with the same name", () => {
    const gmail = domain();
    const first = gmail.createLabel(EMAIL, "RaceLabel");
    expect(first.name).toBe("RaceLabel");
    expect(() => gmail.createLabel(EMAIL, "RaceLabel")).toThrow(/already exists/i);
  });

  it("allocates unique message and history IDs under parallel writers", async () => {
    const gmail = domain();
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        Promise.resolve().then(() => gmail.insertMessage(EMAIL, raw(`Parallel ${index}`, `p${index}@concurrency.test`)))
      )
    );
    const messageIds = results.map((message) => message.id);
    expect(new Set(messageIds).size).toBe(messageIds.length);

    await Promise.all(
      results.map((message) =>
        Promise.resolve().then(() => gmail.modifyMessageLabels(EMAIL, message.id, ["STARRED"]))
      )
    );
    const history = gmail.listHistory(EMAIL, "0");
    const historyIds = history.history.map((event) => event.id);
    expect(new Set(historyIds).size).toBe(historyIds.length);
    expect(historyIds.every((id) => /^\d+$/.test(id))).toBe(true);
  });
});
