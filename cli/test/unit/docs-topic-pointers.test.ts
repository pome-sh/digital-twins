// SPDX-License-Identifier: Apache-2.0
// Help text sends readers to the docs by topic id, as `pome docs cli-run`. The
// id has to resolve, or the pointer is a dead end: `runDocsCommand` prints the
// topic list and exits non-zero on an id it does not know.
//
// This matters because shortening a flag's help moves facts onto a reference
// page and leaves a pointer in their place. A pointer that no longer resolves
// is worse than the paragraph it replaced.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";
import { DOCS_TOPICS } from "../../src/cli/docs-topics.js";

/** Every `pome docs <id>` reference in any command's help, at any depth. */
function referencedTopics(cmd: Command, path: string[] = []): { where: string; id: string }[] {
  const here = path.length === 0 ? cmd.name() : [...path, cmd.name()].join(" ");
  const texts = [
    cmd.description(),
    cmd.summary(),
    ...cmd.options.map((opt) => opt.description),
    ...cmd.registeredArguments.map((arg) => arg.description),
  ];
  const found = texts.flatMap((text) =>
    [...text.matchAll(/`pome docs ([a-z0-9-]+)`/g)].map((match) => ({
      where: here,
      id: match[1]!,
    })),
  );
  const childPath = path.length === 0 ? [cmd.name()] : [...path, cmd.name()];
  return [...found, ...cmd.commands.flatMap((child) => referencedTopics(child, childPath))];
}

describe("`pome docs <topic>` pointers in help text", () => {
  it("name topics the CLI can resolve", () => {
    const ids = new Set(DOCS_TOPICS.map((topic) => topic.id));
    const referenced = referencedTopics(createProgram());

    expect(referenced.length, "no help text points at a docs topic any more").toBeGreaterThan(0);
    for (const { where, id } of referenced) {
      expect(ids.has(id), `\`${where}\` points at \`pome docs ${id}\`, which is not a topic`)
        .toBe(true);
    }
  });
});
