<!-- SPDX-License-Identifier: Apache-2.0 -->

# Showcases

A showcase demonstrates **one property of the twins** against a twin you boot
yourself with `pome twin start`, and stops there. It is not an example agent
and not an exam.

|                      | showcase (`showcases/`)         | example agent (`agent-examples/`) |
| -------------------- | ------------------------------- | --------------------------------- |
| what it ships        | a walkthrough + a verify script | `src/index.ts` + `tasks/*.md`     |
| who acts on the twin | you, or your own coding agent   | the bundled agent                 |
| account              | none — local twin, no login     | none, but the twin is hosted      |
| API key              | none                            | `ANTHROPIC_API_KEY`               |
| graded               | never                           | yes, against graded criteria      |

Two rules hold across every showcase, and both are load-bearing:

- **Single seat.** Your own coding agent both operates Pome and acts on the
  twin. No API key, no Pome-funded inference.
- **Nothing grades.** Grading appears exactly once in this repo, in the
  [`agent-examples/support-triage`](../agent-examples/support-triage/) capstone.
  A showcase may *name* declared checks as pointers; it never ships a task.

A third rule follows from where this repo sits: **showcases teach the local
process.** The OSS repo is the door for someone with no account, so a showcase
boots its twins with `npx @pome-sh/cli@latest twin start` — no `pome login`, no
sandbox, no minutes. The hosted equivalents live on
[docs.pome.sh](https://docs.pome.sh). Anything a showcase claims has to be true
of a twin running on the reader's own machine.

## The showcases

| showcase | property | twins |
| -------- | -------- | ----- |
| [`cross-call-state`](./cross-call-state/) | state written by call N is readable at call N+1 — and does not cross into a second twin process | github |
| [`permission-denial`](./permission-denial/) | a refused write is a recorded event that changes nothing — and the refusal tracks who asked, not which endpoint | github |

## Adding one

Three files, and only these:

| file | job |
| ---- | --- |
| `showcases/README.md` | this page — add one row to the table above |
| `showcases/<property>/README.md` | the walkthrough — the teaching artifact |
| `showcases/<property>/verify.sh` | asserts the property unattended; exits non-zero when it stops holding |

No `package.json`, no `tasks/`, no `src/`, no lockfile. Each of those is what
pulls a directory into a gate that cannot see a showcase's subject —
`gate:examples` and `check-example-pins-published.mjs` discover on
`agent-examples/*/package.json`, `smoke:examples` additionally launches every
hit against dead loopback wiring, and the `task-class` lint collects any `.md`
under a `tasks/` directory. A showcase would pass all of them while proving
nothing, which is the exact failure those gates exist to prevent.

The walkthrough is the teaching artifact and `verify.sh` is its regression
test, not a second teaching surface. Every output block on the page must be
verbatim from a run of the command directly above it — re-run the page after
authoring and diff it, because a page whose argument is "this is real output"
has exactly one class of bug that counts.
