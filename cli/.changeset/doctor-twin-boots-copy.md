---
"@pome-sh/cli": patch
---

Re-word `pome doctor`'s twin check so it no longer overstates liveness (F-906).
The check boots a throwaway local twin, probes its health + session routes, and
tears it down — it never proves a twin is listening — so the pass line now reads
`✓ twin boots locally  github · health + session ok` (was `✓ twin reachable`,
which read as "a twin is up"); the failure label is `local twin check failed`.
`pome doctor` also prints a note on a green report that a green check means the
wiring is right, not that the examinee runs cleanly: `pome doctor` never
launches the agent, and a `pome run` preflight probe launches it with
`POME_PREFLIGHT=1`, which most scaffolds honour by exiting before their real
work path — so a bug on that skipped path surfaces only on a full trial run. The
note is opt-in, so the `run`/`install` gates are unchanged.
