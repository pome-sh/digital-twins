// SPDX-License-Identifier: Apache-2.0
// `pome install` is retired to a redirect, and that redirect is the ONLY
// user-facing account of the retirement — the docs gate in pome-cloud
// (`scripts/check-docs-retired-surface.ts`) keeps docs.pome.sh from documenting
// retired commands, so there is no page to fall back to. It used to end at "the
// pome-intake / REST-launch preflight": two runnable commands, then a step named
// in our vocabulary that no published page defines (F-1683).
//
// So the assertions below are about lookup-ability, not wording. Every skill the
// message names is checked against the `skills/` directory rather than spelled
// twice, and the internal terms are asserted absent by name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runInstall } from "../../src/cli/install.js";
import { createProgram } from "../../src/cli/main.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** The skills `npx skills add` actually installs, read from the source of truth
 *  in this repo. Naming one that is not here is the defect this catches. */
function installedSkills(): string[] {
  return readdirSync(join(REPO_ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe("pome install", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  function captured(): string {
    return errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }

  it("prints the wiring path that replaced it, and exits 0", () => {
    runInstall();

    const out = captured();
    expect(out).toContain("retired");
    // Both install steps are named.
    expect(out).toContain("claude mcp add --transport http pome https://mcp.pome.sh/mcp");
    // The bare form drops the reader on a picker with nothing ticked and
    // the coach only works as a set, so the install-all flag is part of the copy.
    expect(out).toContain("npx skills add pome-sh/digital-twins --skill '*'");
    // A retired command lands the user on the right path — never a non-zero exit.
    expect(process.exitCode).toBeUndefined();
  });

  it("names a step after the two commands, and only skills that exist", () => {
    runInstall();

    // A backticked token with no space in it is a skill name; `pome doctor` and
    // `pome register agent <name>` are commands and are excluded by the space.
    const named = [...captured().matchAll(/`(pome(?:-[a-z]+)*)`/g)].map((m) => m[1]!);
    const skills = installedSkills();

    expect(named.length).toBeGreaterThan(0);
    for (const skill of new Set(named)) {
      expect(skills, `${skill} is named but is not a skill in skills/`).toContain(skill);
    }
  });

  it("ends somewhere the reader can look up", () => {
    runInstall();

    // The whole point of the rewrite: the last thing the message says is a URL
    // that resolves, not a step only we have a name for.
    const urls = [...captured().matchAll(/https:\/\/docs\.pome\.sh\/\S+/g)].map((m) => m[0]!);

    expect(urls).toContain("https://docs.pome.sh/quickstart/claude-code");
    expect(urls.length).toBeGreaterThan(0);
  });

  it("does not advertise the removed Gen-1 flow, or vocabulary the docs lack", () => {
    runInstall();
    const out = captured();
    expect(out).not.toContain("pome-setup");
    expect(out).not.toContain("headless");
    expect(out).not.toContain("approve the diff");
    // Named, not a generic sweep: each of these was in the copy and is defined
    // nowhere on docs.pome.sh. "Gen-1"/"Gen-2" included — the docs site has
    // never used either, so a reader cannot place the generation they are in.
    for (const internal of ["REST-launch", "preflight", "Gen-1", "Gen-2"]) {
      expect(out, `${internal} is internal vocabulary`).not.toContain(internal);
    }
  });

  it("runs from the CLI and tolerates the old flags", async () => {
    const program = createProgram();
    program.exitOverride();
    // Old invocation with a now-removed flag must not throw on an unknown option.
    await expect(
      program.parseAsync(["install", "--interactive"], { from: "user" }),
    ).resolves.toBeDefined();
    expect(captured()).toContain("npx skills add pome-sh/digital-twins");
  });
});
