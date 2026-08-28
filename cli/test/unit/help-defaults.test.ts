// SPDX-License-Identifier: Apache-2.0
// `pome twin reset --help` printed its default twice:
//
//   name        Twin name (default: github) (default: "github")
//
// once from the `.argument()` default value that Commander renders itself, and
// once from a description that also named it. Cosmetic, and the kind of thing a
// reader screenshots.
//
// The assertion is tree-wide rather than about `twin reset`, because the defect
// is a class: any declaration that both carries a default value and names one in
// its own text renders both. Prose like `twin start --port`'s "(default: $PORT,
// else 3333)" is fine, since that option has no Commander default to duplicate.

import type { Command } from "commander";
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

describe("help text never renders a default twice", () => {
  it("holds for every argument in the command tree", () => {
    for (const cmd of allCommands(createProgram())) {
      for (const arg of cmd.registeredArguments) {
        const named = PARENTHESIZED_DEFAULT.test(arg.description);
        const hasDefault = arg.defaultValue !== undefined;
        expect(
          named && hasDefault,
          `${path(cmd)} <${arg.name()}> carries a default value and names one in its text: "${arg.description}"`,
        ).toBe(false);
      }
    }
  });

  it("holds for every option in the command tree", () => {
    for (const cmd of allCommands(createProgram())) {
      for (const opt of cmd.options) {
        const named = PARENTHESIZED_DEFAULT.test(opt.description);
        const hasDefault = opt.defaultValue !== undefined;
        expect(
          named && hasDefault,
          `${path(cmd)} ${opt.flags} carries a default value and names one in its text: "${opt.description}"`,
        ).toBe(false);
      }
    }
  });
});
