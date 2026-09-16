// SPDX-License-Identifier: Apache-2.0
// `pome --help` names `pome twin start` as the way in and demotes the graded
// and hosted commands under "Going further:" (F-1838). The README reads the
// same way; a reader who lands on either sees the same door first.

import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/main.js";

function rootHelp(): string[] {
  const program = createProgram();
  program.configureHelp({ helpWidth: 80 });
  return program.helpInformation().split("\n");
}

describe("pome --help is the door (F-1838)", () => {
  it("names `pome twin start <twin>` as the way in and says what a twin is", () => {
    const description = createProgram().description();
    expect(description).toContain("pome twin start <twin>");
    expect(description).toMatch(/twins of GitHub, Slack, Stripe, Gmail and Linear/);
    expect(description).not.toContain("pome init");
    expect(description).not.toContain("app.pome.sh");
  });

  it("lists twin first, and everything else under Going further", () => {
    const lines = rootHelp();
    const commands = lines.indexOf("Commands:");
    const further = lines.indexOf("Going further:");
    expect(commands).toBeGreaterThan(-1);
    expect(further).toBeGreaterThan(commands);
    expect(lines[commands + 1]).toMatch(/^  twin\s/);
    const door = lines.slice(commands + 1, further).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    expect(door).toEqual(["twin", "help"]);
    const later = lines.slice(further + 1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    for (const name of ["init", "login", "sandbox", "run", "eval", "inspect", "fix-prompt", "capture-server"]) {
      expect(later, `${name} should sit under Going further`).toContain(name);
    }
  });
});
