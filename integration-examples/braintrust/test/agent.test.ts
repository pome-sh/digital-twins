// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { RETRY_POLICIES, WORLDS } from "../src/dataset.js";
import { buildSystemPrompt, refundRequest } from "../src/agent.js";

describe("buildSystemPrompt", () => {
  // THE DISCONNECTED-GUARD CASE. Every number this example reports depends on
  // the two arms actually differing in the agent's instructions. Delete
  // `${policy.retryRule}` from the template and the arms become identical: the
  // experiment still runs, every column still fills in, and the whole demo
  // quietly measures nothing. Nothing else in this suite would notice.
  it("puts the arm's retry rule into the prompt", () => {
    for (const policy of Object.values(RETRY_POLICIES)) {
      expect(buildSystemPrompt(policy)).toContain(policy.retryRule);
    }
  });

  it("gives both arms the same job, so the runs differ in the retry rule alone", () => {
    const [a, b] = Object.values(RETRY_POLICIES).map(buildSystemPrompt);
    const strip = (prompt: string, rule: string) => prompt.replace(rule, "«RETRY RULE»");

    expect(strip(a, RETRY_POLICIES["retry-on-5xx"].retryRule)).toBe(
      strip(b, RETRY_POLICIES["verify-then-retry"].retryRule),
    );
  });

  // The agent is never told the refund can land on a 500. If it were, the arm
  // difference would be a hint rather than a policy, and the red would be
  // authored rather than earned.
  it("never tells the agent that a failed refund may have landed", () => {
    for (const policy of Object.values(RETRY_POLICIES)) {
      expect(buildSystemPrompt(policy)).not.toMatch(/after_handler|lost response|double refund/i);
    }
  });
});

describe("refundRequest", () => {
  // Real Stripe takes form-encoded bodies, and so does the twin. Sending JSON
  // here parses to no `charge` at all, which comes back `parameter_missing` —
  // an error the agent would then RETRY, manufacturing the very behaviour this
  // dataset is trying to measure.
  it("form-encodes the refund the way a Stripe SDK would", () => {
    const req = refundRequest("https://twins.pome.sh/stripe/s/ses_x/", "edt_tok", {
      charge: WORLDS[0]!.chargeId,
      amountMinorUnits: WORLDS[0]!.refundMinorUnits,
    });

    expect(req.url).toBe("https://twins.pome.sh/stripe/s/ses_x/v1/refunds");
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(req.headers.authorization).toBe("Bearer edt_tok");
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      charge: "ch_test_200",
      amount: "5000",
    });
  });
});
