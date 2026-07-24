---
"@pome-sh/cli": patch
---

`pome docs tasks` now points at the renamed docs.pome.sh page. The M4 docs door
(F-912) renamed `/docs/cli/scenarios` to `/docs/cli/tasks` on docs.pome.sh; this
repoints the `cli-tasks` topic's `path` to match. A redirect on the docs site
keeps the old `/docs/cli/scenarios` URL alive, and the `scenarios` keyword stays
on the topic so `pome docs scenarios` still resolves to the `pome tasks` page.
