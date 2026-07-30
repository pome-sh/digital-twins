---
"@pome-sh/cli": minor
---

`pome checks gmail` answers with a vocabulary instead of "not migrated yet"
(F-1128).

Gmail is the third twin to declare its assertable checks, and the first whose
migration needed plumbing before vocabulary: pome-cloud had no in-process seed
loader for it, so every gmail criterion reported `no_seed_loader` — not a wrong
verdict, an absent one.

The CLI half is the pin and the registry entry. `gmail` leaves
`TWINS_WITHOUT_CHECKS` and `@pome-sh/twin-gmail` is repinned to 0.3.0, which is
the release that carries the `./checks` subpath. `pome checks stripe` and
`pome checks linear` still answer "not migrated yet"; those are F-1127 and
F-1129.
