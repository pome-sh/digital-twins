---
"@pome-sh/cli": patch
---

Re-word `pome doctor`'s twin check so it no longer overstates liveness (F-906).
The check boots a throwaway local twin, probes its health + session routes, and
tears it down — it never proves a twin is listening — so the pass line now reads
`✓ twin boots locally  github · health + session ok` (was `✓ twin reachable`,
which read as "a twin is up"); the failure label is `local twin check failed`.
`pome doctor` also prints a one-line note on a green report that it verifies the
wiring, not that the examinee's own code launches — the preflight probe
(`POME_PREFLIGHT=1`) early-returns the agent before its body runs, so a
launch-fatal bug there (e.g. a TDZ crash) surfaces only on a real run. The note
is opt-in, so the `run`/`install` gates are unchanged.
