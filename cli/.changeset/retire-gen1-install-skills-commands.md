---
"@pome-sh/cli": minor
---

Retire the Gen-1 `pome install` and `pome skills` CLI wiring commands (F-893,
follow-up to F-859). `pome install` no longer runs a headless coding-agent
wiring session — its knowledge layer was the `pome-setup` skill, which F-859
turned into a redirect tombstone, so the wiring stopped running. It now prints
the Gen-2 wiring path (`claude mcp add --transport http pome https://mcp.pome.sh/mcp`
+ `npx skills add pome-sh/digital-twins`, then the `pome-intake` / REST-launch
preflight) and exits 0; old invocations with the removed flags still land on the
redirect. The `pome skills` / `pome skills install` command is removed — it only
symlinked the two tombstone skills into `~/.claude/skills/`; install the Gen-2
coach set with `npx skills add pome-sh/digital-twins`. The bundled `cli/skills/`
tombstone sources are no longer packed with the CLI.
