# Pome coach skills

The Gen-2 **coach** skill set for testing agents on the Pome platform. The
coach (your Claude session with these skills installed) talks to the builder
and to the Pome control MCP (`mcp.pome.sh`); the **examinee** is a sandbox
clone of the builder's agent, run against Pome's digital twins and graded from
the live twin tape.

## Install (one command)

```bash
npx skills add pome-sh/digital-twins
```

The [`skills` CLI](https://github.com/vercel-labs/skills) discovers every
`skills/<name>/SKILL.md` in this repo and installs the set into your agent's
skills directory (e.g. `~/.claude/skills/`). Each skill ships with its
`references/` so one-level-deep links resolve.

Then connect the Pome control MCP so the `mcp__pome__*` tools resolve:

```bash
claude mcp add --transport http pome https://mcp.pome.sh/mcp
```

## The set

| Skill | Role |
| --- | --- |
| [`pome`](./pome/SKILL.md) | **Entry router** — owns "test my agent with pome"; routes to the right coach skill by context |
| [`pome-intake`](./pome-intake/SKILL.md) | Skill 0 — register the examinee clone scope, report twin coverage |
| [`pome-author-task`](./pome-author-task/SKILL.md) | Skill 1 — author a graded task and save it to the team catalog |
| [`pome-verify-seed`](./pome-verify-seed/SKILL.md) | Skill 2 — verify a task's seed is a fair exam before any run |
| [`pome-run-task`](./pome-run-task/SKILL.md) | Skill 4 — run the exam, finalize from the live tape, narrate the report |

Tool names cited in these skills are verbatim from the frozen Pome control MCP
contract v1.0 (F-851). Tasks authored here are saved into **your team's**
catalog via `save_task` on first use — there is no cross-team task library.

## Source of truth

This directory in `pome-sh/digital-twins` is the canonical home of the coach
skill set (decided 2026-07-22, F-850); it versions with the repo. Copies
elsewhere (e.g. the pome-cloud docs site) are mirrors or pointers. Historical
test evidence (fixtures, kept e2e transcripts) stays in the pome-cloud repo
under `apps/docs/docs/skills/`.

The Gen-1 CLI-era skills `pome-setup` / `pome-test` (once installed by the
`pome skills install` command, and injected by `pome install`) were **retired at
F-859 (M2)** as redirect tombstones pointing here, then **removed outright at
F-893**: the `pome skills` command is gone, `pome install` now just prints the
Gen-2 wiring path (`pome-setup` → `pome-intake` + the REST-launch preflight;
`pome-test` → `pome-run-task`).
Their rescue-worthy assets landed here — the `pome doctor` preflight and the
adapter/`withPome()` REST wiring depth in
[`pome-run-task/references/launch-rest.md`](./pome-run-task/references/launch-rest.md),
and the 0–5 CI exit-code contract in [`cli/README.md`](../cli/README.md). The
`skills` CLI does not pick the tombstones up — only this top-level `skills/`
directory is a standard discovery location — and the [`pome`](./pome/SKILL.md)
router owns Gen-1's shared trigger phrases so the two generations never collide
on an entry point (F-801).
