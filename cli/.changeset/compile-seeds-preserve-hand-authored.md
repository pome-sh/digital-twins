---
"@pome-sh/cli": patch
---

`pome compile-seeds` no longer overwrites seeds it did not author. Sidecars marked `"model": "hand-authored"` (or `"source_hash": "sha256:hand-authored"`) are now an explicit skip, reported as `keep … hand-authored seed left untouched`. Previously the sentinel could never equal a real sha256, so the cache check always missed and the seed was silently recompiled — rewriting the adversarial setups the starter tasks depend on (a backdoored PR, a fabricated green CI status, an exfiltration lure) while the run still reported normally. The skip outranks `--force`, since it states authorship rather than staleness; delete the sidecar or drop its `_meta` to recompile.

Tasks naming another twin alongside `github` are now skipped too. Their seed is a per-twin envelope (`{ github: {...}, slack: {...} }`) and the compiler only emits a flat `github` seed, so compiling one replaced the envelope and dropped the other twin's half — reachable today via the six `examples/minimal-viktor-langgraph` tasks, whose envelopes carry no `_meta` to protect them.
