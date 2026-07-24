// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { openGmailTwinDatabase } from "../src/index.js";
import { checkFault, gmailFaultSchema } from "../src/faults.js";
import { GmailError, gmailErrorEnvelope } from "../src/errors.js";

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
