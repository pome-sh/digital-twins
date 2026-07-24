# pome-suggest-tasks — coach own-agent front door

Propose a builder's first Pome task by reading their already-registered agent:
read `pome.json` (`twins`) + the agent's prompt/code, propose 2–3 grounded
candidates, interview to pick one, then hand to `pome-author-task`. The skill
itself is [`SKILL.md`](./SKILL.md); the one-session chain it fronts is
[`references/cold-walk.md`](./references/cold-walk.md).

## Layout

One authored source per skill — this directory. Nothing is generated from it.

```
pome-suggest-tasks/
├── SKILL.md      # the skill (frontmatter + instructions, <100 lines)
├── references/   # cold-walk.md — the six-step chain, loaded on demand
└── README.md     # this file
```

## Role

Runs after registration (F-858), before Skill 1 (`pome-author-task`) — the
own-agent parallel to `pome-intake` (Skill 0, for managed agents). It closes the
M2 "users don't know how to write tasks" gap by **proposing** tasks grounded in
what the agent actually does, not by docs (F-891). It authors nothing itself: it
produces one chosen candidate and hands off to the authoring chain.

## Install

Part of the coach set — install the whole set with one command (see
[`skills/README.md`](../README.md)); `references/` ships with the skill so the
one-level-deep link resolves:

```bash
npx skills add pome-sh/digital-twins
```

Requires the Pome control MCP connection (`claude mcp add --transport http pome
https://mcp.pome.sh/mcp`) so the `mcp__pome__*` tools resolve.
