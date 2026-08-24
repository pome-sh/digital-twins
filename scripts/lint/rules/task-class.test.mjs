#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case 5 is why this table exists rather than a "it went green once" note. The
// rule's whole job is to refuse a task that declares no class — and the cheapest
// way for it to stop doing that job is for the WALK to stop finding the file,
// not for the check to break. A rule that scans nothing prints the same success
// line as a rule that scanned everything. So the table asserts the zero-file
// case is RED, and that a task nested one level deeper than `tasks/` is still
// seen.

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
    // The failure mode a passing rule cannot distinguish itself from.
    name: "a corpus that resolves to zero task files is RED, not green",
    files: { "README.md": "# not a corpus\n" },
    expect: "red",
    contains: "Refusing to pass a zero-file scan",
  },
  {
    // The walk, asserted rather than assumed. `agent-examples/<agent>/tasks/<file>.md`
    // is two levels down; a walker that only looked at direct children of the
    // corpus root would silently exempt every example task.
    name: "an example task two levels below the corpus root is seen",
    files: {
      "cli/tasks/01-a.md": task("conformance"),
      "agent-examples/agent/tasks/01-unlabelled.md": task(null),
    },
    expect: "red",
    contains: "agent-examples/agent/tasks/01-unlabelled.md",
  },
  {
    // The walker gap from the other side: a task nested UNDER a `tasks/`
    // directory must still be seen. `collectTaskFiles` reads `.md` at depth 0 or
    // in any directory literally named `tasks`, so a `tasks/<topic>/`
    // subdirectory is a live way to leave the corpus.
    name: "a task in a subdirectory of `tasks/` is seen",
    files: {
      "cli/tasks/01-a.md": task("conformance"),
      "cli/tasks/github/01-unlabelled.md": task(null),
    },
    expect: "red",
    contains: "cli/tasks/github/01-unlabelled.md",
  },
  {
    // A README sitting beside the tasks is not a task. Counting it would inflate
    // a denominator pome-cloud pins, and it carries no criteria to classify.
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
