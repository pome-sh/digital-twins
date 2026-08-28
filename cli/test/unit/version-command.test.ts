// SPDX-License-Identifier: Apache-2.0
// There were two ways to print the version, both in root `--help`:
//
//   $ pome version    -> 0.33.0
//   $ pome --version  -> 0.33.0
//
// Byte-identical output from a subcommand and the flag every CLI has. The
// subcommand is gone, so the assertions below hold the flag to the job: it
// answers, and it answers with the installed version rather than a literal
// someone typed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));
const installedVersion = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version as string;

describe("there is one way to ask for the version", () => {
  it("registers no `version` subcommand", () => {
    const names = createProgram().commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]);
    expect(names).not.toContain("version");
  });

  it("reports the version from package.json through --version", () => {
    // Narrow on purpose: under vitest this exercises the filesystem branch of
    // `readPackageVersion`, not the tsup `PKG_VERSION` define the published
    // build uses. What it catches is resolution collapsing to the "0.0.0"
    // fallback, which is the mode that would ship a binary unable to say which
    // build it is.
    expect(createProgram().version()).toBe(installedVersion);
  });

  it("offers the flag in root --help, and no command beside it", () => {
    const program = createProgram();
    program.configureHelp({ helpWidth: 80 });
    const help = program.helpInformation();

    expect(help).toContain("-V, --version");
    // Over the whole text, not a slice from "Commands:": a missing block would
    // make indexOf return -1 and the slice check pass while reading one char.
    const lines = help.split("\n");
    expect(lines.filter((line) => line.trimStart().startsWith("version"))).toHaveLength(0);
  });
});
