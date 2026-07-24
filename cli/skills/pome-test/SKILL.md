---
name: pome-test
description: RETIRED (F-859). The Gen-1 CLI-era test-runner skill, superseded by the unified Gen-2 coach set (install with `npx skills add pome-sh/digital-twins`). Resolves only on the explicit "/pome-test" invocation, so a user who still has Gen-1 installed and types it lands on a pointer to the Gen-2 `pome-run-task` skill instead of dead air. It runs nothing itself — it redirects. The shared natural-language phrases ("test my agent with pome", "run pome") belong to the `pome` router (F-801).
---

# pome-test — retired (F-859)

This Gen-1 CLI-era skill is **retired**. Its job — run a repo's tasks against
pome's twins and report pass/fail — now lives in the unified **Gen-2 coach skill
set** (the top-level `skills/` directory in this repo; install with
`npx skills add pome-sh/digital-twins`).

**Where its job went:**

- **Run + score** → the **`pome-run-task`** skill: `run_task` mints the session,
  you launch the examinee, `finalize_run` scores from the **live twin tape**,
  and `get_report` narrates the verdict. Verifying a task's seed is a fair exam
  is a separate step first (**`pome-verify-seed`**).
- **CI one-shot / the 0–5 exit-code contract** → `pome run <task>` in CI. The
  exit-code table now lives in **`cli/README.md`** (the "CI one-shot" section)
  so it survives this retirement.

Auth uses the macOS Keychain service **`sh.pome.cli`** (account `hosted`) — the
canonical CLI service name. Do not follow the old steps from memory: they
referenced retired surfaces (`TESTS.md`, `pome scenarios`). Redirect the user to
the Gen-2 set above.
