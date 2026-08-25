// SPDX-License-Identifier: Apache-2.0
// `sandbox create --twin`'s help is the public discovery surface for which twins
// exist. It was hand-written, and it went stale the release linear mounted: the
// flag accepted `linear`, the twin booted, and `--help` still said
// `github | stripe | slack | gmail`. A reader browsing help concluded a working
// twin was unavailable.
//
// So the assertions below are all one shape — the help text and the code that
// validates the flag must never be able to name different sets. Nothing here
// spells a twin id: the expectations are derived from `MOUNTED_TWINS`, which is
// what makes them fail rather than pass the day a sixth twin mounts.

import type { Command, Option } from "commander";
import { describe, expect, it } from "vitest";

import { MOUNTED_TWINS } from "../../src/contract/index.js";
import { createProgram } from "../../src/cli/main.js";
import { normalizeSessionTwins } from "../../src/cli/session.js";

/** `--help` calls `process.exit()`, which takes the vitest worker down instead
 *  of failing an assertion. `exitOverride()` only reaches the commands that
 *  existed when it was called, so walk the tree the program already built. */
function program(): Command {
  const root = createProgram();
  const walk = (cmd: Command) => {
    cmd.exitOverride();
    cmd.commands.forEach(walk);
  };
  walk(root);
  return root;
}

/** The rendered text a user actually reads. Commander soft-wraps the option
 *  column at word boundaries, so whitespace is collapsed: a twin name is never
 *  split mid-word, but the list can straddle a line. */
function renderedHelp(...argv: string[]): string {
  const chunks: string[] = [];
  const root = program();
  const walk = (cmd: Command) => {
    cmd.configureOutput({
      writeOut: (s) => void chunks.push(s),
      writeErr: (s) => void chunks.push(s),
    });
    cmd.commands.forEach(walk);
  };
  walk(root);
  try {
    root.parse(["node", "pome", ...argv]);
  } catch (err) {
    // `--help` exits through exitOverride once the text is already written.
    if ((err as { code?: string }).code !== "commander.helpDisplayed") throw err;
  }
  return chunks.join("").replace(/\s+/g, " ");
}

/** The `--twin` option as declared, before help wrapping touches it. */
function twinOption(): Option {
  const create = program()
    .commands.find((cmd) => cmd.name() === "session")
    ?.commands.find((cmd) => cmd.name() === "create");
  if (!create) throw new Error("`session create` is no longer in the command tree");
  const option = create.options.find((opt) => opt.long === "--twin");
  if (!option) throw new Error("`session create` no longer declares --twin");
  return option;
}

describe("`sandbox create --twin` help agrees with the mounted-twin set", () => {
  it("lists every mounted twin, in the mounted order", () => {
    // Ordered and exact, not five `toContain`s: an enumeration derived from
    // `MOUNTED_TWINS` reproduces its order, and a hand-written one that happens
    // to hold the same five names does not stay that way.
    expect(twinOption().description).toContain(MOUNTED_TWINS.join(" | "));
  });

  it("reaches the text `sandbox create --help` prints", () => {
    const help = renderedHelp("sandbox", "create", "--help");

    for (const twin of MOUNTED_TWINS) {
      expect(help, `${twin} is mounted but absent from --help`).toContain(twin);
    }
  });

  it("names only twins the flag's own validator accepts", () => {
    // The help line and `normalizeSessionTwins` are the two halves that drifted.
    // Feeding one to the other is the assertion the original defect fails.
    const listed = twinOption()
      .description.split(".")[0]!
      .split("|")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    expect(listed).toEqual([...MOUNTED_TWINS]);
    expect(normalizeSessionTwins(listed)).toEqual([...MOUNTED_TWINS]);
  });

  it("keeps its worked example runnable", () => {
    // The prose example names twins too, and rots the same way the list did.
    // Twin-id shape, not `\S+`: the last name in the example is followed by
    // `).`, and swallowing that punctuation would make this assert on a string
    // no twin was ever going to equal.
    const exampled = [...twinOption().description.matchAll(/--twin ([a-z][a-z0-9-]*)/g)].map(
      (match) => match[1]!,
    );

    expect(exampled.length).toBeGreaterThan(1);
    expect(() => normalizeSessionTwins(exampled)).not.toThrow();
  });

  it("rejects a twin it does not list", () => {
    expect(twinOption().description).not.toContain("notion");
    expect(() => normalizeSessionTwins(["notion"])).toThrow(/Unknown twin "notion"/);
  });
});
