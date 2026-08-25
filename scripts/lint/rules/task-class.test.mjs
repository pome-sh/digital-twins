#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for task-class. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { defineCases } from "../harness.mjs";

const task = (cls) =>
  [
    "# A task",
    "",
    "## Prompt",
    "",
    "Do the thing.",
    "",
    "## Success Criteria",
    "",
    "- [code] Issue #1 in `acme/api` has the `bug` label applied",
    "",
    "## Config",
    "",
    "```yaml",
    "twins: [github]",
    ...(cls === null ? [] : [`class: ${cls}`]),
    "timeout: 60",
    "passThreshold: 100",
    "```",
    "",
  ].join("\n");

defineCases("task-class", [
  {
    name: "every task declaring a valid class is green",
    files: {
      "cli/tasks/01-a.md": task("conformance"),
      "cli/tasks/02-b.md": task("restraint"),
      "agent-examples/agent/tasks/03-c.md": task("adversarial"),
    },
    expect: "green",
    contains: "1 conformance, 1 restraint, 1 adversarial",
  },
  {
    name: "a task with no `class:` line is a violation, and is NAMED",
    files: {
      "cli/tasks/01-a.md": task("conformance"),
      "cli/tasks/02-unlabelled.md": task(null),
    },
    expect: "red",
    contains: "cli/tasks/02-unlabelled.md",
  },
  {
    name: "a class outside the vocabulary is a violation",
    files: { "cli/tasks/01-a.md": task("smoke") },
    expect: "red",
    contains: "class: smoke",
  },
  {
    name: "a task with no `## Config` block at all is a violation",
    files: { "cli/tasks/01-a.md": "# A task\n\n## Prompt\n\nDo the thing.\n" },
    expect: "red",
    contains: "cli/tasks/01-a.md",
  },
  {
    name: "a corpus that resolves to zero task files is RED, not green",
    files: { "README.md": "# not a corpus\n" },
    expect: "red",
    contains: "Refusing to pass a zero-file scan",
  },
  {
    name: "an example task two levels below the corpus root is seen",
    files: {
      "cli/tasks/01-a.md": task("conformance"),
      "agent-examples/agent/tasks/01-unlabelled.md": task(null),
    },
    expect: "red",
    contains: "agent-examples/agent/tasks/01-unlabelled.md",
  },
  {
    name: "a task in a subdirectory of `tasks/` is seen",
    files: {
      "cli/tasks/01-a.md": task("conformance"),
      "cli/tasks/github/01-unlabelled.md": task(null),
    },
    expect: "red",
    contains: "cli/tasks/github/01-unlabelled.md",
  },
  {
    name: "a README beside the tasks is not counted as a task",
    files: {
      "agent-examples/agent/tasks/01-a.md": task("conformance"),
      "agent-examples/agent/README.md": "# how to run this example\n",
      "agent-examples/agent/VERIFICATION.md": "# verification\n",
    },
    expect: "green",
    contains: "1 task(s)",
  },
]);
