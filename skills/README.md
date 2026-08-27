# Pome coach skills

The **coach** skill set for testing agents on the Pome platform. The
coach (your Claude session with these skills installed) talks to the builder
and to the Pome control MCP (`mcp.pome.sh`); the **examinee** is a sandbox
clone of the builder's agent, run against Pome's digital twins and graded from
the live twin tape.

## Install (one command)

```bash
npx skills add pome-sh/digital-twins --skill '*'
```

The [`skills` CLI](https://github.com/vercel-labs/skills) discovers every
`skills/<name>/SKILL.md` in this repo and installs the set into your agent's
skills directory (e.g. `~/.claude/skills/`). Each skill ships with its
`references/` so one-level-deep links resolve.

`--skill '*'` takes all six without the picker. If you drop the flag, the
picker opens on a **Pome Coach** row (from `.claude-plugin/plugin.json`) whose
radio selects the whole set with one space — the coach only works whole, since
`pome` routes into the other five.

Then connect the Pome control MCP so the `mcp__pome__*` tools resolve:

```bash
claude mcp add --transport http pome https://mcp.pome.sh/mcp
```

## The set

| Skill | Role |
| --- | --- |
| [`pome`](./pome/SKILL.md) | **Entry router** — owns "test my agent with pome"; routes to the right coach skill by context |
| [`pome-intake`](./pome-intake/SKILL.md) | Skill 0 — register the examinee clone scope, report twin coverage |
| [`pome-suggest-tasks`](./pome-suggest-tasks/SKILL.md) | Own-agent front door — read a registered agent (`pome.json` + prompt/code), propose grounded candidate tasks, interview to pick one; runs before Skill 1 |
| [`pome-author-task`](./pome-author-task/SKILL.md) | Skill 1 — author a graded task and save it to the team catalog |
| [`pome-verify-seed`](./pome-verify-seed/SKILL.md) | Skill 2 — verify a task's seed is a fair exam before any run |
| [`pome-run-task`](./pome-run-task/SKILL.md) | Skill 4 — run the exam, finalize from the live tape, narrate the report |

Tool names cited in these skills are verbatim from the frozen Pome control MCP
contract v1.0. Tasks authored here are saved into **your team's**
catalog via `save_task` on first use — there is no cross-team task library.

## Source of truth

This directory in `pome-sh/digital-twins` is the canonical home of the coach
skill set (decided 2026-07-22); it versions with the repo. Copies
elsewhere (e.g. the pome-cloud docs site) are mirrors or pointers. Test
evidence (fixtures, kept e2e transcripts) stays in the pome-cloud repo under
`docs/agents/skill-evidence/` — deliberately *outside* `apps/docs/`, because
Mintlify publishes every markdown file under that root whether or not the nav
lists it, so evidence parked there rendered as public pages on `docs.pome.sh`.

The REST wiring depth lives in
[`pome-run-task/references/launch-rest.md`](./pome-run-task/references/launch-rest.md),
and the 0–5 CI exit-code contract in [`cli/README.md`](../cli/README.md).
