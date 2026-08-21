// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { composeMime, GmailDomain, openGmailTwinDatabase } from "../src/index.js";
import { checkFault, gmailFaultSchema } from "../src/faults.js";
import { GmailError, gmailErrorEnvelope } from "../src/errors.js";
import { defaultSeedState, parseSeed } from "../src/seed.js";

function dbWithFault(fault: unknown) {
  const db = openGmailTwinDatabase(":memory:");
  const parsed = gmailFaultSchema.parse(fault);
  db.prepare("INSERT INTO gmail_config(key, value) VALUES ('faults', ?)").run(JSON.stringify([parsed]));
  return db;
}

describe("rate-limited fault", () => {
  it("passes succeedFirst, throttles throttleFor, then recovers", () => {
    const db = dbWithFault({ name: "rate-limited", target: "messages.send", succeedFirst: 2, throttleFor: 3 });
    const statuses: (number | "ok")[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        checkFault(db, "messages.send");
        statuses.push("ok");
      } catch (e) {
        statuses.push((e as GmailError).status);
      }
    }
    // calls 1-2 ok, 3-5 throttled (429), 6-8 ok again
    expect(statuses).toEqual(["ok", "ok", 429, 429, 429, "ok", "ok", "ok"]);
  });

  it("does nothing when no fault targets the operation", () => {
    const db = dbWithFault({ name: "rate-limited", target: "messages.send" });
    expect(() => checkFault(db, "drafts.send")).not.toThrow();
  });

  it("does nothing when no faults are configured", () => {
    const db = openGmailTwinDatabase(":memory:");
    expect(() => checkFault(db, "messages.send")).not.toThrow();
  });

  it("rejects an unknown fault name", () => {
    expect(() => gmailFaultSchema.parse({ name: "kaboom" })).toThrow();
  });
});

describe("429 envelope", () => {
  it("maps 429 to RESOURCE_EXHAUSTED", () => {
    const env = gmailErrorEnvelope(new GmailError(429, "rateLimitExceeded", "slow down"));
    expect(env.status).toBe(429);
    expect((env.body as any).error.status).toBe("RESOURCE_EXHAUSTED");
    expect((env.body as any).error.errors[0].reason).toBe("rateLimitExceeded");
  });
});

describe("seed integration", () => {
  it("default seed has no faults", () => {
    expect(parseSeed(defaultSeedState()).faults).toEqual([]);
  });

  it("domain.seed persists faults and gate reads them", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test" },
      faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 1, throttleFor: 1 }],
    } as never);
    expect(() => checkFault(db, "messages.send")).not.toThrow(); // call 1 ok
    expect(() => checkFault(db, "messages.send")).toThrow(); // call 2 throttled
  });

  it("reset clears the fault counter", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test" },
      faults: [{ name: "rate-limited", succeedFirst: 0, throttleFor: 1 }],
    } as never);
    expect(() => checkFault(db, "messages.send")).toThrow(); // call 1 throttled
    gmail.resetToDefault(); // clears counter + faults
    expect(() => checkFault(db, "messages.send")).not.toThrow();
  });
});

describe("sendMessage gate", () => {
  it("throttles the 2nd send when succeedFirst=1, throttleFor=1", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test", displayName: "Agent" },
      faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 1, throttleFor: 1 }],
    } as never);
    const raw = composeMime({
      from: "agent@pome-twin.test",
      to: ["x@pome-twin.test"],
      subject: "hi",
      text: "hi",
      date: "2026-07-24T12:00:00.000Z",
      messageId: "gate@test",
    });
    expect(() => gmail.sendMessage("agent@pome-twin.test", raw)).not.toThrow(); // 1st ok
    let status = 0;
    try {
      gmail.sendMessage("agent@pome-twin.test", raw);
    } catch (e) {
      status = (e as GmailError).status;
    }
    expect(status).toBe(429); // 2nd throttled
  });

  // The gate has to run OUTSIDE sendMessage's transaction. A throttled call must
  // still advance the counter — that is what lets a retrying agent walk out of
  // the throttle window. Move checkFault inside the transaction and the rollback
  // undoes its own increment, so the window never closes and every retry 429s
  // forever. Nothing but the call site's position enforces that, so this is the
  // test that fails if it moves.
  it("lets a retry walk out of the throttle window", () => {
    const db = openGmailTwinDatabase(":memory:");
    const gmail = new GmailDomain(db);
    gmail.seed({
      primaryMailbox: { email: "agent@pome-twin.test", displayName: "Agent" },
      faults: [{ name: "rate-limited", target: "messages.send", succeedFirst: 0, throttleFor: 1 }],
    } as never);
    const raw = composeMime({
      from: "agent@pome-twin.test",
      to: ["x@pome-twin.test"],
      subject: "hi",
      text: "hi",
      date: "2026-07-24T12:00:00.000Z",
      messageId: "retry-recovers@test",
    });
    const send = () => gmail.sendMessage("agent@pome-twin.test", raw);
    expect(send).toThrow(); // call 1 throttled, and it still counted
    expect(send).not.toThrow(); // so the retry clears the window
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBeGreaterThan(0);
  });
});
