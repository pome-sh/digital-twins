---
"@pome-sh/cli": patch
---

`pome register agent` now prints a `Dashboard:` line deep-linking the registered
agent's page (`<dashboard>/agents/<slug>`) as the final handoff (F-905). The base
resolves from `POME_DASHBOARD_URL` (default `https://app.pome.sh`), matching the
runner's reliability-page handoff. This makes the docs.pome.sh onboarding walk —
which asks for "the dashboard line register printed" — agree with reality; before
this, register printed four lines and no URL.
