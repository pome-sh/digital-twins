// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — the doctor's terminal rendering, per `CLI moments.dc.html`
// moment 03: check lines, then (on failure) exactly one cause/fix card and
// the two closing warning lines.

import { describe, expect, it } from "vitest";
import { renderDoctorReport } from "../../../src/doctor/render.js";
import type { DoctorReport } from "../../../src/doctor/checks.js";

describe("renderDoctorReport", () => {
  it("renders all-pass reports without a cause card", () => {
    const report: DoctorReport = {
      ok: true,
      checks: [
        { id: "config", status: "pass", label: "pome.config.json found" },
        { id: "twin", status: "pass", label: "twin boots locally", detail: "github · health + session ok" },
        { id: "routing", status: "pass", label: "requests route to the twin", detail: "reads POME_GITHUB_REST_URL" },
        { id: "egress", status: "pass", label: "egress floor active", detail: "deny-by-default · 6 pattern(s) + loopback" },
      ],
    };

    const text = renderDoctorReport(report).join("\n");
    expect(text).toContain("checking your wiring …");
    expect(text).toContain("✓ pome.config.json found");
    expect(text).toContain("✓ twin boots locally  github · health + session ok");
    expect(text).not.toContain("cause");
    expect(text).not.toContain("your agent would hit production");
  });

  it("omits the preflight pass-note by default, but appends it when passNote is set (F-906)", () => {
    const report: DoctorReport = {
      ok: true,
      checks: [
        { id: "config", status: "pass", label: "pome.json found" },
        { id: "twin", status: "pass", label: "twin boots locally", detail: "github · health + session ok" },
      ],
    };

    // The run/install consumers render without the note.
    expect(renderDoctorReport(report).join("\n")).not.toContain("POME_PREFLIGHT");

    // `pome doctor` opts in — a green report is not "the agent can launch".
    const text = renderDoctorReport(report, { passNote: true }).join("\n");
    expect(text).toContain("a green check means the wiring is right, not that your agent runs");
    expect(text).toContain("pome doctor never launches it");
    expect(text).toContain("POME_PREFLIGHT=1");
  });

  it("never shows the pass-note on a failing report, even when passNote is set", () => {
    const report: DoctorReport = {
      ok: false,
      checks: [
        {
          id: "config",
          status: "fail",
          label: "pome manifest not found",
          cause: "no pome.json or pome.yaml found.",
          fix: "run pome init, then re-run pome doctor",
        },
      ],
    };

    const text = renderDoctorReport(report, { passNote: true }).join("\n");
    expect(text).not.toContain("POME_PREFLIGHT");
    expect(text).toContain("until this passes, your agent would hit production.");
  });

  it("renders one cause/fix card and the production warning on failure", () => {
    const report: DoctorReport = {
      ok: false,
      checks: [
        { id: "config", status: "pass", label: "pome.config.json found" },
        { id: "twin", status: "pass", label: "twin boots locally", detail: "github · health + session ok" },
        {
          id: "routing",
          status: "fail",
          label: "requests are not routed to the twin",
          cause:
            "src/agent/triage.ts reads from a hardcoded https://api.github.com on line 12, ignoring POME_GITHUB_REST_URL — so its requests would bypass the twin.",
          fix: "read the base URL from the env the runner injects —\nconst { POME_GITHUB_REST_URL: baseUrl } = process.env\nthen re-run pome doctor",
        },
      ],
    };

    const lines = renderDoctorReport(report);
    const text = lines.join("\n");
    expect(text).toContain("✗ requests are not routed to the twin");
    expect(text).toContain(
      "cause  src/agent/triage.ts reads from a hardcoded https://api.github.com on line 12, ignoring POME_GITHUB_REST_URL — so its requests would bypass the twin.",
    );
    expect(text).toContain("fix    read the base URL from the env the runner injects —");
    // Continuation lines of the fix stay aligned under the fix column.
    expect(text).toContain("       const { POME_GITHUB_REST_URL: baseUrl } = process.env");
    expect(text).toContain("until this passes, your agent would hit production.");
    expect(text).toContain("pome will not run trials against a live API.");
  });
});
