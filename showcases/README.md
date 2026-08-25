<!-- SPDX-License-Identifier: Apache-2.0 -->

# Showcases

A showcase demonstrates **one property of the twins** against a live hosted
sandbox, and stops there. It is not an example agent and not an exam.

|                     | showcase (`showcases/`)          | example agent (`agent-examples/`) |
| ------------------- | -------------------------------- | --------------------------------- |
| what it ships       | a walkthrough + a verify script   | `src/index.ts` + `tasks/*.md`     |
| who acts on the twin | you, or your own coding agent    | the bundled agent                 |
| API key             | none                             | `ANTHROPIC_API_KEY`               |
| graded              | never                            | yes, against graded criteria      |

Two rules hold across every showcase, and both are load-bearing:

- **Single seat.** Your own coding agent both operates Pome and acts on the
  twin. No API key, no Pome-funded inference.
- **Nothing grades.** Grading appears exactly once in this repo, in the
  [`agent-examples/support-triage`](../agent-examples/support-triage/) capstone.
  A showcase may *name* declared checks as pointers; it never ships a task.

| showcase | property |
| -------- | -------- |
| [`cross-call-state`](./cross-call-state/) | state written by call N is readable at call N+1 — and does not cross sandboxes |
