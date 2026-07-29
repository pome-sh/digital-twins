---
"@pome-sh/cli": minor
---

`pome checks github` now lists **twelve** declared checks, not eleven.

`github.no-unsupported-endpoint` — "No unsupported endpoint was called" — was the one
GitHub predicate F-1075 left behind as a regex in the cloud, because whether a
declaration may read the recorded call tape was still an open question. It is declared
in `@pome-sh/twin-github@0.5.0`, and GitHub now has no hand-written predicate left
anywhere.

It is the first check to declare `substrate: "tape"`, and it has to be: an unsupported
call leaves no state trace at all. The twin answers 501 and mutates nothing, so
`state_final.json` is byte-identical whether the examinee reached for an unimplemented
route or never tried. The `fidelity: "unsupported"` stamp on the recorded event is the
only place the fact survives. It takes no parameters and names no repository — the repo
rule exists to stop a check selecting state ambiguously, and this one selects no state.

**This bump is not optional.** The cloud already serves the twelve-check vocabulary, and
`pome checks add` compares its digest against the cloud's before writing — so
`@pome-sh/cli@0.11.0` refuses **every** `github` criterion it is asked to write, not only
this one, naming `github.no-unsupported-endpoint` as the check the cloud has and it does
not. That refusal is the designed safe behaviour rather than a bug, but this pin is what
clears it.

Nothing that bound before stops binding: the other eleven checks keep their ids, their
sentences, and their parameters, so tasks written against `0.11.0` re-render unchanged.

Also bundles `@pome-sh/sdk@0.8.0`, which the declaration requires — `CheckSubstrate.tape`
does not exist before it.
