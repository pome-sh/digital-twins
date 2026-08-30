// SPDX-License-Identifier: Apache-2.0
// A declaration that carries a default value AND names that default in its own
// text renders it twice:
//
//   name        Twin name (default: github) (default: "github")
//
// once from the value Commander renders itself, once from the description.
// Cosmetic, and the kind of thing a reader screenshots.
//
// The assertion is tree-wide because the defect is a class, not one command's
// typo. Prose like `twin start --port`'s "(default: $PORT, else …)" is fine,
// since that option has no Commander default to duplicate.

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

/** Every command in the tree, including subcommands and hidden ones. */
function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap((cmd) => allCommands(cmd))];
}

function path(cmd: Command): string {
  const names: string[] = [];
  for (let node: Command | null = cmd; node; node = node.parent) names.unshift(node.name());
  return names.join(" ");
}

/** Only a parenthesized default, which is the shape Commander itself renders
 *  and therefore the shape that duplicates. Prose like "instead of each twin's
 *  default" stays legal, and has to: `sandbox create --seed` needs it. */
const PARENTHESIZED_DEFAULT = /\(default[: )]/i;

/** Every declaration that carries a default AND names one in its own text. */
function duplicatedDefaults(root: Command): string[] {
  const violations: string[] = [];
  for (const cmd of allCommands(root)) {
    const declarations = [
      ...cmd.registeredArguments.map((arg) => ({
        term: `<${arg.name()}>`,
        description: arg.description,
        defaultValue: arg.defaultValue,
      })),
      ...cmd.options.map((opt) => ({
        term: opt.flags,
        description: opt.description,
        defaultValue: opt.defaultValue,
      })),
    ];
    for (const { term, description, defaultValue } of declarations) {
      if (PARENTHESIZED_DEFAULT.test(description) && defaultValue !== undefined) {
        violations.push(`${path(cmd)} ${term} carries a default and names one: "${description}"`);
      }
    }
  }
  return violations;
}

describe("help text never renders a default twice", () => {
  it("holds for every argument and option in the command tree", () => {
    expect(duplicatedDefaults(createProgram())).toEqual([]);
  });

  // Green on today's tree proves nothing, so break it here instead of in
  // main.ts: one argument and one option, each doubling its own default.
  it("fails on a declaration that names the default it already carries", () => {
    const program = new Command("pome")
      .argument("[name]", "Twin name (default: github)", "github")
      .option("--limit <n>", "Max rows (default: 20)", "20");
    expect(duplicatedDefaults(program)).toHaveLength(2);
  });
});
