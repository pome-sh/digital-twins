// SPDX-License-Identifier: Apache-2.0
//
// Minimal guard for a quickstart example. See the sibling comment in
// minimal-viktor-langgraph for what is deliberately left to the other gates.

import { describe, expect, it } from "vitest";

import { checkSlack } from "../scripts/run-trials.js";
import { parseOtlpHeaders } from "../src/telemetry.js";

const msg = (text: string) => ({ text, user_id: "U_AGENT", ts: "1.0" });

describe("minimal-viktor", () => {
  it("checks the Slack channel for the merge it was asked to report", () => {
    const reported = checkSlack("01-clean-merge", [
      msg("successfully merged viktor-hq/orders-service #1: Fix typo in module docstring"),
    ]);
    expect(reported.every((c) => c.pass)).toBe(true);
    expect(checkSlack("01-clean-merge", []).every((c) => c.pass)).toBe(false);
  });

  it("parses OTLP headers, and treats an unset value as none", () => {
    expect(parseOtlpHeaders("x-api-key=abc123")).toEqual({ "x-api-key": "abc123" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
});
