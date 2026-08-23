// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { gmailSeedStateSchema } from "../../../src/contract/seed-state.js";

describe("gmailSeedStateSchema faults", () => {
  it("defaults faults to []", () => {
    const parsed = gmailSeedStateSchema.parse({ primaryMailbox: { email: "a@b.test" } });
    expect(parsed.faults).toEqual([]);
  });

  it("accepts a rate-limited fault", () => {
    const parsed = gmailSeedStateSchema.parse({
      primaryMailbox: { email: "a@b.test" },
      faults: [{ name: "rate-limited", target: "messages.send" }],
    });
    expect(parsed.faults[0].name).toBe("rate-limited");
  });

  it("rejects an unknown fault name", () => {
    expect(() =>
      gmailSeedStateSchema.parse({ primaryMailbox: { email: "a@b.test" }, faults: [{ name: "kaboom" }] }),
    ).toThrow();
  });
});
