// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — terminal rendering for the doctor report, per
// `CLI moments.dc.html` moment 03: one line per executed check, then (on
// failure) exactly one cause/fix card and the two closing warning lines.
// Plain text, no color deps — matches the rest of the CLI's output.

import type { DoctorReport } from "./checks.js";

const CAUSE_COLUMN = "cause  ";
const FIX_COLUMN = "fix    ";
const CONTINUATION = " ".repeat(FIX_COLUMN.length);

export interface RenderDoctorReportOptions {
  /** First line of the report. `pome doctor` and the run gate keep the
   *  moment-03 default; `pome install` passes moment 02's
   *  "verifying the wiring …" (FDRS-642). */
  header?: string;
  /** F-906 — when the report passes, append a one-line caveat that a green
   *  doctor verifies wiring, not that the examinee's own code launches: the
   *  preflight probe (POME_PREFLIGHT=1) early-returns the agent before its
   *  body runs, so a launch-fatal bug there surfaces only on a real run.
   *  Opt-in so only `pome doctor` shows it — the `run`/`install` consumers
   *  print the report as a gate, not as a self-diagnosis. */
  passNote?: boolean;
}

export function renderDoctorReport(
  report: DoctorReport,
  options: RenderDoctorReportOptions = {},
): string[] {
  const lines: string[] = [options.header ?? "checking your wiring …"];

  for (const check of report.checks) {
    const glyph = check.status === "pass" ? "✓" : "✗";
    const detail = check.detail ? `  ${check.detail}` : "";
    lines.push(`${glyph} ${check.label}${detail}`);
  }

  const failed = report.checks.find((c) => c.status === "fail");
  if (failed) {
    lines.push("");
    if (failed.cause) lines.push(`${CAUSE_COLUMN}${failed.cause}`);
    if (failed.fix) {
      const [first, ...rest] = failed.fix.split("\n");
      lines.push(`${FIX_COLUMN}${first ?? ""}`);
      for (const line of rest) lines.push(`${CONTINUATION}${line}`);
    }
    lines.push("");
    lines.push("until this passes, your agent would hit production.");
    lines.push("pome will not run trials against a live API.");
  } else if (options.passNote) {
    lines.push("");
    lines.push(
      "note: this checks the wiring, not that your agent launches cleanly — the",
    );
    lines.push(
      "preflight probe exits your agent early (POME_PREFLIGHT=1), so a startup bug",
    );
    lines.push(
      "in its own code (e.g. a TDZ crash) can still surface only on a real run.",
    );
  }

  return lines;
}
