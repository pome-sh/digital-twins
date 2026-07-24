---
name: pome-setup
description: RETIRED (F-859). The Gen-1 CLI-era wiring skill, superseded by the unified Gen-2 coach set (install with `npx skills add pome-sh/digital-twins`). Resolves only on the explicit "/pome-setup" invocation, so a user who still has Gen-1 installed and types it lands on a pointer to the Gen-2 skills instead of dead air. It wires nothing itself — it redirects. The shared natural-language phrases ("wire my agent to pome", "set up pome") belong to the `pome` router.
---

# pome-setup — retired (F-859)

This Gen-1 CLI-era skill is **retired**. Its job — wire a repo's agent to pome
and prove the wiring — now lives in the unified **Gen-2 coach skill set** (the
top-level `skills/` directory in this repo; install with
`npx skills add pome-sh/digital-twins`).

**Where its job went:**

- **Register the examinee** → the **`pome-intake`** skill (collect the clone
  scope, report twin coverage). For a self-hosted REST agent, one
  `register_agent(name, twins)` call — the single "register an agent" verb.
- **Prove the wiring** — the `pome doctor` preflight (config → twin reachable →
  routing → egress floor) → the **`pome-run-task`** REST launcher
  (`skills/pome-run-task/references/launch-rest.md`), which runs exactly those
  checks before launching a REST examinee, stopping at the first failure with
  one cause + one fix. Repos that have the CLI still run `pome doctor` directly.

Do not follow the old steps below-the-fold from memory — they referenced retired
surfaces (`pome.config.json`, now `pome.json`; `pome scenarios`;
`pome run --local`). Redirect the user to the Gen-2 set above.
