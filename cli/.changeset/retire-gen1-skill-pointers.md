---
"@pome-sh/cli": patch
---

Retire the Gen-1 `/pome-setup` and `/pome-test` skills to redirect pointers
(F-859). `pome skills install`'s post-install banner and the `pome skills`
help text now say the skills are retired and point to the Gen-2 coach set
(`npx skills add pome-sh/digital-twins`) instead of advertising them as the
way to wire and test an agent.
